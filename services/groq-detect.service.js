/**
 * groq-detect.service.js
 *
 * Uses the Groq API (llama-3.3-70b-versatile) to analyse cloned repository
 * files and infer the correct startup command when static heuristics fail.
 *
 * Called only when GROQ_API_KEY is present in the environment.
 * Always resolves — never rejects — so the pipeline can fall through gracefully.
 */

'use strict';

const fs   = require('fs/promises');
const path = require('path');
const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL        = 'llama-3.3-70b-versatile';
const TIMEOUT_MS   = 20_000;

/** Read a file, returning its text or null if missing / unreadable. */
async function tryRead(filePath, maxBytes = 6000) {
  try {
    const buf = await fs.readFile(filePath);
    const text = buf.slice(0, maxBytes).toString('utf8');
    return text;
  } catch {
    return null;
  }
}

/** Collect the most informative files from the repo for the AI prompt. */
async function collectContext(repoRoot) {
  const sections = [];

  // Files that carry startup intent, in priority order
  const candidates = [
    'package.json',
    'pnpm-workspace.yaml',
    'lerna.json',
    'Procfile',
    'fireboxdeploy.toml',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'README.md',
    'README',
    '.env.example',
    'ecosystem.config.js',
  ];

  for (const file of candidates) {
    const content = await tryRead(path.join(repoRoot, file));
    if (content !== null) {
      sections.push(`### ${file}\n\`\`\`\n${content.trim()}\n\`\`\``);
    }
  }

  // Top-level directory listing
  try {
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    sections.push(`### Directory listing (root)\n\`\`\`\n${names}\n\`\`\``);
  } catch {}

  // If it looks like a monorepo, sample sub-package package.json files
  const workspaceDirs = ['apps', 'packages', 'services'];
  for (const dir of workspaceDirs) {
    const dirPath = path.join(repoRoot, dir);
    let entries;
    try { entries = await fs.readdir(dirPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.filter((e) => e.isDirectory()).slice(0, 4)) {
      const subPkg = await tryRead(path.join(dirPath, entry.name, 'package.json'), 2000);
      if (subPkg) {
        sections.push(`### ${dir}/${entry.name}/package.json\n\`\`\`json\n${subPkg.trim()}\n\`\`\``);
      }
    }
  }

  return sections.join('\n\n');
}

/**
 * Ask Groq to infer the startup command from the collected repo context.
 *
 * @param {string} repoRoot   Absolute path to the cloned (sub-dir) root
 * @param {Function} log      Pipeline log function (level, message)
 * @returns {Promise<string|null>}  The command string, or null if AI can't determine it
 */
async function detectStartCommand(repoRoot, log) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log('warn', '  GROQ_API_KEY not set — skipping AI start-command detection');
    return null;
  }

  log('info', '  Asking Groq AI to analyse repository and infer startup command…');

  let context;
  try {
    context = await collectContext(repoRoot);
  } catch (err) {
    log('warn', `  Could not collect repo context for AI: ${err.message}`);
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
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature: 0,
        max_tokens:  120,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
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

    // Sanity-check: reject anything that looks like a paragraph rather than a command
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

module.exports = { detectStartCommand };
