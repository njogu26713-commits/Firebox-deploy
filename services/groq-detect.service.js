/**
 * groq-detect.service.js
 *
 * Uses Groq (llama-3.3-70b-versatile) to infer a Node.js startup command from
 * repository files.  Two entry points:
 *
 *   detectStartCommand(deployPath, log)
 *     — reads files from a locally-cloned directory (used inside the pipeline)
 *
 *   detectStartCommandFromGitHub(repoUrl, branch, log)
 *     — fetches key files from GitHub raw URLs (used by the UI "AI Detect" button)
 *
 * Both always resolve (never throw) so callers can treat a null return as
 * "AI couldn't help" and continue.
 */

'use strict';

const fs    = require('fs/promises');
const path  = require('path');
const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL        = 'llama-3.3-70b-versatile';
const TIMEOUT_MS   = 20_000;

// ── Shared: call Groq with assembled context ──────────────────────────────────

async function callGroq(context, log) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log('warn', '  GROQ_API_KEY not set — skipping AI start-command detection');
    return null;
  }

  const systemPrompt = `You are a deployment assistant. Your ONLY job is to determine the shell command that starts a Node.js application given repository files.

Rules:
- Reply with ONLY the shell command — no explanation, no markdown, no quotes around it.
- If the repo is a monorepo workspace, include a cd to the right sub-package, e.g.: cd apps/api && node dist/index.js
- Prefer commands from scripts.start, Procfile web:, or Dockerfile CMD/ENTRYPOINT in that order.
- If you genuinely cannot determine the command, reply with exactly: UNKNOWN
- Do not guess randomly. UNKNOWN is better than a wrong command.`;

  const userPrompt = `Here are the repository files:\n\n${context}\n\nWhat is the shell command to start this application?`;

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model:       MODEL,
        messages:    [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature: 0,
        max_tokens:  120,
      },
      {
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );

    const raw = (response.data?.choices?.[0]?.message?.content || '').trim();

    if (!raw || raw === 'UNKNOWN') {
      log('warn', '  Groq AI could not determine a startup command');
      return null;
    }

    // Reject anything that looks like a paragraph rather than a command
    if (raw.includes('\n') || raw.length > 300) {
      log('warn', `  Groq AI returned an unexpected response — ignoring: ${raw.slice(0, 80)}…`);
      return null;
    }

    log('info', `  Groq AI suggested start command: ${raw}`);
    return raw;

  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    log('warn', `  Groq AI request failed (non-fatal): ${detail}`);
    return null;
  }
}

// ── Local filesystem entry point (used inside the deploy pipeline) ────────────

/** Read a file, returning its text or null if missing / unreadable. */
async function tryRead(filePath, maxBytes = 6000) {
  try {
    const buf = await fs.readFile(filePath);
    return buf.slice(0, maxBytes).toString('utf8');
  } catch { return null; }
}

async function collectContextFromDisk(repoRoot) {
  const sections = [];

  const candidates = [
    'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'Procfile',
    'fireboxdeploy.toml', 'Dockerfile', 'docker-compose.yml',
    'README.md', 'README', '.env.example', 'ecosystem.config.js',
  ];

  for (const file of candidates) {
    const content = await tryRead(path.join(repoRoot, file));
    if (content !== null) sections.push(`### ${file}\n\`\`\`\n${content.trim()}\n\`\`\``);
  }

  try {
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    const names   = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    sections.push(`### Directory listing (root)\n\`\`\`\n${names}\n\`\`\``);
  } catch {}

  for (const dir of ['apps', 'packages', 'services']) {
    const dirPath = path.join(repoRoot, dir);
    let entries;
    try { entries = await fs.readdir(dirPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.filter((e) => e.isDirectory()).slice(0, 4)) {
      const subPkg = await tryRead(path.join(dirPath, entry.name, 'package.json'), 2000);
      if (subPkg) sections.push(`### ${dir}/${entry.name}/package.json\n\`\`\`json\n${subPkg.trim()}\n\`\`\``);
    }
  }

  return sections.join('\n\n');
}

/**
 * Infer start command from a locally-cloned repo.
 * @param {string}   repoRoot  Absolute path to the deploy root
 * @param {Function} log
 * @returns {Promise<string|null>}
 */
async function detectStartCommand(repoRoot, log) {
  log('info', '  Asking Groq AI to analyse repository and infer startup command…');
  try {
    const context = await collectContextFromDisk(repoRoot);
    return await callGroq(context, log);
  } catch (err) {
    log('warn', `  Could not collect repo context for AI: ${err.message}`);
    return null;
  }
}

// ── GitHub entry point (used by the UI "AI Detect" button) ───────────────────

async function fetchGitHubRaw(owner, repo, branch, filePath) {
  try {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const res = await axios.get(url, { timeout: 8000, responseType: 'text' });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return text.slice(0, 6000);
  } catch { return null; }
}

async function collectContextFromGitHub(owner, repo, branch) {
  const filesToFetch = [
    'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'Procfile',
    'fireboxdeploy.toml', 'Dockerfile', 'docker-compose.yml',
    'README.md', '.env.example', 'ecosystem.config.js',
  ];

  const results = await Promise.all(
    filesToFetch.map(async (f) => ({ file: f, content: await fetchGitHubRaw(owner, repo, branch, f) }))
  );

  const sections = results
    .filter((r) => r.content !== null)
    .map((r) => `### ${r.file}\n\`\`\`\n${r.content.trim()}\n\`\`\``);

  // Try common sub-package package.json files
  const subPkgPaths = [
    'apps/api/package.json', 'apps/web/package.json', 'apps/server/package.json',
    'packages/api/package.json', 'services/api/package.json',
  ];
  const subResults = await Promise.all(
    subPkgPaths.map(async (f) => ({ file: f, content: await fetchGitHubRaw(owner, repo, branch, f) }))
  );
  for (const { file, content } of subResults) {
    if (content !== null) sections.push(`### ${file}\n\`\`\`json\n${content.trim()}\n\`\`\``);
  }

  return sections.join('\n\n');
}

/**
 * Infer start command by fetching repo files from GitHub (no clone needed).
 * @param {string}   repoUrl   e.g. https://github.com/owner/repo
 * @param {string}   branch
 * @param {Function} log
 * @returns {Promise<string|null>}
 */
async function detectStartCommandFromGitHub(repoUrl, branch = 'main', log) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
  if (!match) {
    log('warn', 'Not a valid GitHub URL — cannot fetch files for AI detection');
    return null;
  }
  const [, owner, repo] = match;

  log('info', `Fetching repo files from GitHub for AI analysis (${owner}/${repo}@${branch})…`);
  try {
    const context = await collectContextFromGitHub(owner, repo, branch);
    if (!context) {
      log('warn', 'No files could be fetched from GitHub');
      return null;
    }
    return await callGroq(context, log);
  } catch (err) {
    log('warn', `GitHub context collection failed: ${err.message}`);
    return null;
  }
}

module.exports = { detectStartCommand, detectStartCommandFromGitHub };
