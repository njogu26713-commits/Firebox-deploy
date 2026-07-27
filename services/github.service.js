const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/config');
const {
  detectPackageManager,
  getPackageManagerCommands,
} = require('./package-manager.service');

function client(token) {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    timeout: 10000,
  });
}

/** List repositories accessible to the connected GitHub account. */
async function listRepos(userToken) {
  if (!userToken) throw new Error('No GitHub token configured. Add one in Settings.');
  const api = client(userToken);
  const { data } = await api.get('/user/repos', {
    params: { per_page: 100, sort: 'updated', affiliation: 'owner,collaborator' },
  });
  return data.map((r) => ({
    fullName:      r.full_name,
    name:          r.name,
    private:       r.private,
    defaultBranch: r.default_branch,
    cloneUrl:      r.clone_url,
    description:   r.description,
    updatedAt:     r.updated_at,
  }));
}

/** Register a push webhook on the repo for auto-redeploy. */
async function createWebhook(fullName, callbackUrl, userToken) {
  const api = client(userToken);
  const { data } = await api.post(`/repos/${fullName}/hooks`, {
    name: 'web',
    active: true,
    events: ['push'],
    config: {
      url: callbackUrl,
      content_type: 'json',
      secret: config.github.webhookSecret || '',
    },
  });
  return data;
}

function verifyWebhookSignature(signature256, rawBody) {
  if (!config.github.webhookSecret) return true;
  const hmac   = crypto.createHmac('sha256', config.github.webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature256 || ''));
  } catch {
    return false;
  }
}

/**
 * Fetch a single file's decoded text content from a repo.
 * Returns null if the file doesn't exist or isn't readable.
 */
async function fetchFileText(fullName, filePath, branch, api) {
  try {
    const { data } = await api.get(`/repos/${fullName}/contents/${filePath}`, {
      params: { ref: branch },
    });
    if (data.encoding === 'base64' && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect build command and start command by inspecting package.json,
 * Procfile, and common framework config files in the repository.
 *
 * Returns: { buildCommand, startCommand, framework, detected }
 *   detected = true  → confident match from well-known framework
 *   detected = false → best-effort guess from scripts only
 */
async function detectCommands(fullName, branch = 'main', userToken) {
  if (!userToken) throw new Error('No GitHub token configured. Add one in Settings.');
  const api = client(userToken);
  branch = branch || 'main';

  // ── 1. Fetch all files we need in parallel ─────────────────────────────
  const [pkgRaw, procfileRaw, pnpmLock, yarnLock, npmLock] = await Promise.all([
    fetchFileText(fullName, 'package.json', branch, api),
    fetchFileText(fullName, 'Procfile',     branch, api),
    fetchFileText(fullName, 'pnpm-lock.yaml', branch, api),
    fetchFileText(fullName, 'yarn.lock', branch, api),
    fetchFileText(fullName, 'package-lock.json', branch, api),
  ]);

  let pkg = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; } catch { /* malformed */ }

  const scripts = pkg?.scripts || {};
  const deps    = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const packageManager = detectPackageManager({
    pnpm: pnpmLock !== null,
    yarn: yarnLock !== null,
    npm: npmLock !== null,
  });
  const managerCommands = getPackageManagerCommands(packageManager, {
    hasBuildScript: Boolean(scripts.build),
  });

  // ── 2. Framework detection (ordered by specificity) ─────────────────────
  const framework = detectFramework(deps, scripts);

  // ── 3. Procfile has highest priority for start command ───────────────────
  let procfileStart = null;
  if (procfileRaw) {
    const match = procfileRaw.match(/^web:\s*(.+)/m);
    if (match) procfileStart = match[1].trim();
  }

  // ── 4. Build start commands based on detected framework ─────────────────
  let buildCommand = '';
  let startCommand = '';
  let detected     = false;

  switch (framework) {
    case 'nextjs':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.start || managerCommands.startCommand;
      detected = true; break;

    case 'cra':   // Create React App
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || 'npx serve -s build';
      detected = true; break;

    case 'vite':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.preview || 'npx serve dist';
      detected = true; break;

    case 'nuxt':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.start  || 'node .output/server/index.mjs';
      detected = true; break;

    case 'astro':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || 'node ./dist/server/entry.mjs';
      detected = true; break;

    case 'gatsby':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.serve  || 'npx serve public';
      detected = true; break;

    case 'nestjs':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.start  || 'node dist/main';
      detected = true; break;

    case 'remix':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.start || managerCommands.startCommand;
      detected = true; break;

    case 'sveltekit':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.start  || 'node build';
      detected = true; break;

    case 'express':
    case 'fastify':
    case 'hono':
    case 'koa':
      // Pure API / server — usually no build step needed
      buildCommand = scripts.build  || '';
      startCommand = procfileStart  || scripts.start  || guessMainEntry(pkg);
      detected = true; break;

    case 'ts-node':
      buildCommand = scripts.build  || managerCommands.buildCommand;
      startCommand = procfileStart  || scripts.start  || 'node dist/index.js';
      detected = true; break;

    default:
      // Unknown: use whatever is in package.json scripts
      buildCommand = scripts.build  || '';
      startCommand = procfileStart  || scripts.start  || guessMainEntry(pkg, managerCommands.startCommand);
      detected     = !!(buildCommand || startCommand);
  }

  return { buildCommand, startCommand, framework, detected };
}

/** Pick a framework name from the dependency map + scripts. */
function detectFramework(deps, scripts) {
  if (deps['next'])              return 'nextjs';
  if (deps['nuxt'])              return 'nuxt';
  if (deps['@remix-run/node'] || deps['@remix-run/react']) return 'remix';
  if (deps['astro'])             return 'astro';
  if (deps['gatsby'])            return 'gatsby';
  if (deps['react-scripts'])     return 'cra';
  if (deps['@sveltejs/kit'])     return 'sveltekit';
  if (deps['@nestjs/core'])      return 'nestjs';
  if (deps['vite'])              return 'vite';
  if (deps['fastify'])           return 'fastify';
  if (deps['hono'])              return 'hono';
  if (deps['koa'])               return 'koa';
  if (deps['express'])           return 'express';
  if (deps['ts-node'] || (deps['typescript'] && (scripts.build || '').includes('tsc'))) return 'ts-node';
  return 'unknown';
}

/** Try to infer a start command from package.json main field or common entrypoints. */
function guessMainEntry(pkg, defaultStartCommand = 'npm start') {
  if (!pkg) return defaultStartCommand;
  const main = pkg.main;
  if (main) return `node ${main}`;
  return defaultStartCommand;
}

module.exports = { listRepos, createWebhook, verifyWebhookSignature, detectCommands };
