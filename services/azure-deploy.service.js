/**
 * Azure App Service deployment pipeline with full streaming output.
 *
 * Every command (git clone, npm install, build, zip) is spawned so its
 * stdout/stderr flow to the browser terminal in real time.  After the
 * clone the directory tree is listed so the user can see exactly what
 * was checked out before anything else runs.
 *
 * Pipeline:
 *  1. Clone Repository        – git clone --progress (streams git output)
 *  2. Inspect Repository      – list files, read package.json
 *  3. Install Dependencies    – npm/yarn/pnpm install (streamed)
 *  4. Build                   – run build script if present (streamed)
 *  5. Create Package          – zip the staged directory
 *  6. Get Publishing Credentials – fetch Kudu basic-auth from Azure
 *  7. Upload to Azure         – POST zip to Kudu zipdeploy
 *  8. Deployment Status       – poll + stream Kudu build logs
 *  9. Verify Application      – poll app URL until it responds
 */

'use strict';

const fs      = require('fs/promises');
const path    = require('path');
const os      = require('os');
const { spawn } = require('child_process');
const axios   = require('axios');

const azure = require('./azure.service');

// ── Tunables ─────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS       = 3_000;
const LOG_POLL_INTERVAL_MS   = 2_000;
const DEFAULT_TIMEOUT_MS     = 15 * 60_000;
const APP_STARTUP_TIMEOUT_MS =  3 * 60_000;

// ── Pipeline step names (must match PIPELINE_STEPS in public/js/azure.js) ───
const STEPS = {
  PROVISION:   'Provision App Service',
  CLONE:       'Clone Repository',
  INSPECT:     'Inspect Repository',
  INSTALL:     'Install Dependencies',
  BUILD:       'Build',
  PACKAGE:     'Create Package',
  CREDENTIALS: 'Get Publishing Credentials',
  UPLOAD:      'Upload to Azure',
  POLL:        'Deployment Status',
  STARTUP:     'Verify Application',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function deploymentError(message, details = {}) {
  const err = new Error(message);
  Object.assign(err, details);
  return err;
}

function responseBody(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

function decodeXml(v) {
  return String(v)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parsePublishProfile(xml) {
  const profiles = [...String(xml || '').matchAll(/<publishProfile\b([^>]*)\/?>/gi)];
  const attrs = {};
  for (const [, raw] of profiles) {
    for (const m of raw.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = decodeXml(m[2]);
    if (attrs.publishMethod === 'MSDeploy' || attrs.publishUrl) break;
  }
  if (!attrs.publishUrl || !attrs.userName || !attrs.userPWD)
    throw deploymentError('Azure publishing profile did not contain Kudu credentials');
  const base = attrs.publishUrl.startsWith('http') ? attrs.publishUrl : `https://${attrs.publishUrl}`;
  return { publishUrl: base.replace(/\/+$/, ''), userName: attrs.userName, password: attrs.userPWD };
}

function parseDeploymentStatus(d) {
  const raw = d?.status;
  if (typeof raw === 'number') return raw === 4 ? 'success' : raw === 3 ? 'failed' : 'pending';
  const s = String(raw || d?.status_text || '').toLowerCase();
  if (['success','successful','succeeded','done','complete','completed'].includes(s)) return 'success';
  if (['failed','failure','error','rejected'].includes(s)) return 'failed';
  return 'pending';
}

function extractDeploymentId(location, data) {
  const m = String(location || '').match(/\/deployments\/([^/?#]+)/i);
  return m?.[1] || data?.id || data?.deploymentId || null;
}

// ── Provisioning tunables ─────────────────────────────────────────────────────
const CRED_MAX_ATTEMPTS  = 6;
const CRED_RETRY_MS      = 5_000;

// ── Provision App Service (resource group → plan → app) ──────────────────────

/**
 * Creates the Azure resource group, App Service Plan, and App Service if they
 * do not already exist. Idempotent — each step is skipped when the resource
 * is already present.
 *
 * @param {object}   opts
 * @param {string}   opts.resourceGroup
 * @param {string}   opts.name           – App Service name
 * @param {string}   [opts.location]     – Azure region (default: eastus)
 * @param {string}   [opts.planName]     – Plan name (default: <name>-plan)
 * @param {string}   [opts.planSku]      – Plan SKU (default: B1)
 * @param {string}   [opts.runtimeStack] – linuxFxVersion (default: NODE|18-lts)
 * @param {Function} log                 – (level, msg) => void
 * @returns {{ planId: string, planName: string }}
 */
async function provisionAppService(opts, log) {
  const {
    resourceGroup,
    name,
    location     = 'eastus',
    planName: requestedPlan = '',
    planSku      = 'B1',
    runtimeStack = 'NODE|18-lts',
  } = opts;

  const resolvedPlanName = requestedPlan || `${name}-plan`;

  // ── Resource Group ──────────────────────────────────────────────────────────
  const rgs = await azure.listResourceGroups();
  if (rgs.some((rg) => rg.name === resourceGroup)) {
    log('info', `✓ Resource group "${resourceGroup}" already exists`);
  } else {
    log('info', `Creating resource group "${resourceGroup}" in ${location}…`);
    await azure.createResourceGroup(resourceGroup, location);
    log('info', `✓ Resource group "${resourceGroup}" created`);
  }

  // ── App Service Plan ────────────────────────────────────────────────────────
  const plans = await azure.listAppServicePlans();
  let planId;
  const existingPlan = plans.find((p) => p.name === resolvedPlanName);
  if (existingPlan) {
    planId = existingPlan.id;
    log('info', `✓ App Service Plan "${resolvedPlanName}" already exists`);
  } else {
    log('info', `Creating App Service Plan "${resolvedPlanName}" (${planSku}, Linux)…`);
    const plan = await azure.createAppServicePlan(resourceGroup, resolvedPlanName, location, planSku, true);
    planId = plan.id;
    log('info', `✓ App Service Plan "${resolvedPlanName}" created`);
  }

  // ── App Service ─────────────────────────────────────────────────────────────
  let appExists = false;
  try {
    await azure.getApp(resourceGroup, name);
    appExists = true;
  } catch (e) {
    if (e.azureStatus !== 404) throw e;
  }

  if (appExists) {
    log('info', `✓ App Service "${name}" already exists`);
  } else {
    log('info', `Creating App Service "${name}" (${runtimeStack})…`);
    await azure.createApp(resourceGroup, name, location, planId, runtimeStack);
    log('info', `✓ App Service "${name}" created`);
  }

  return { planId, planName: resolvedPlanName };
}

// ── Kudu HTTP ─────────────────────────────────────────────────────────────────

async function kuduRequest(profile, method, reqPath, opts = {}) {
  try {
    return await axios({
      method, url: `${profile.publishUrl}${reqPath}`,
      auth: { username: profile.userName, password: profile.password },
      timeout: opts.timeout || 30_000,
      responseType: opts.responseType || 'json',
      headers: opts.headers, data: opts.data,
      maxContentLength: opts.maxContentLength,
      maxBodyLength: opts.maxBodyLength,
      validateStatus: () => true,
    });
  } catch (e) {
    throw deploymentError(`Kudu ${method} ${reqPath}: ${e.message}`, { cause: e });
  }
}

// ── Spawn a command and stream every line through the log callback ────────────

function spawnStreaming(cmd, args, cwd, log, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let combined  = '';

    const emit = (stream, chunk) => {
      const text = stream === 'stdout' ? (stdoutBuf += chunk) : (stderrBuf += chunk);
      void text;
      // Flush complete lines
      const lines = (stream === 'stdout' ? stdoutBuf : stderrBuf).split('\n');
      if (stream === 'stdout') stdoutBuf = lines.pop();
      else                     stderrBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        combined += line + '\n';
        log('info', line, stream);
      }
    };

    proc.stdout.on('data', (d) => emit('stdout', d.toString()));
    proc.stderr.on('data', (d) => emit('stderr', d.toString()));

    proc.on('close', (code) => {
      // Flush remaining partial lines
      if (stdoutBuf.trim()) { combined += stdoutBuf; log('info', stdoutBuf, 'stdout'); }
      if (stderrBuf.trim()) { combined += stderrBuf; log('info', stderrBuf, 'stderr'); }

      if (code === 0) return resolve(combined);
      const err = deploymentError(
        `${cmd} ${args.slice(0, 3).join(' ')} exited with code ${code}`,
        { commandOutput: combined.slice(-4000) }
      );
      reject(err);
    });

    proc.on('error', (e) => reject(deploymentError(`Failed to start ${cmd}: ${e.message}`, { cause: e })));
  });
}

// ── Ensure a package manager binary is available, installing it if needed ────

/**
 * Ensure `pm` is executable, installing it if needed.
 * Returns the absolute path to the binary so callers never rely on PATH.
 * @param {'npm'|'yarn'|'pnpm'} pm
 * @param {Function} log
 * @returns {Promise<string>} resolved binary path
 */
async function ensurePackageManager(pm, log) {
  const { execSync } = require('child_process');

  if (pm === 'npm') return 'npm'; // always on PATH with Node

  /** Try to locate an already-installed binary; returns '' if not found. */
  function resolveBin(name) {
    for (const cmd of [
      `which ${name} 2>/dev/null`,
      `command -v ${name} 2>/dev/null`,
    ]) {
      try {
        const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (out) return out;
      } catch { /* try next */ }
    }
    // Fallback: npm global bin directory
    try {
      const npmBin = execSync('npm bin -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const candidate = path.join(npmBin, name);
      execSync(`test -x ${candidate}`, { stdio: 'ignore' });
      return candidate;
    } catch {}
    return '';
  }

  /** Verify the binary actually executes; returns version string or throws. */
  function verifyBin(binPath) {
    return execSync(`${binPath} --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }

  // ── pnpm: prefer Corepack ─────────────────────────────────────────────────
  if (pm === 'pnpm') {
    // Check if pnpm is already present and working
    const existing = resolveBin('pnpm');
    if (existing) {
      try {
        const ver = verifyBin(existing);
        log('info', `✓ pnpm executable: ${existing} (v${ver})`);
        return existing;
      } catch { /* not working — reinstall below */ }
    }

    // Try Corepack first (Node ≥ 16.9)
    const hasCorepack = (() => { try { execSync('which corepack', { stdio: 'ignore' }); return true; } catch { return false; } })();
    if (hasCorepack) {
      log('info', 'Enabling pnpm via Corepack…');
      await spawnStreaming('corepack', ['enable'], process.cwd(), log);
      await spawnStreaming('corepack', ['prepare', 'pnpm@latest', '--activate'], process.cwd(), log);
    } else {
      log('info', 'pnpm not found in PATH — installing via npm…');
      await spawnStreaming('npm', ['install', '-g', 'pnpm'], process.cwd(), log);
    }

    const resolved = resolveBin('pnpm');
    if (!resolved) {
      throw deploymentError(
        'pnpm executable not found after installation — ' +
        'ensure Node.js ≥16.9 is installed and Corepack is available on this host.'
      );
    }
    let ver;
    try { ver = verifyBin(resolved); } catch {
      throw deploymentError(
        `pnpm found at ${resolved} but failed to execute — check file permissions.`
      );
    }
    log('info', `✓ pnpm executable: ${resolved} (v${ver})`);
    return resolved;
  }

  // ── yarn (and any other future pm) ───────────────────────────────────────
  const existing = resolveBin(pm);
  if (existing) {
    try { verifyBin(existing); return existing; } catch { /* reinstall */ }
  }

  log('info', `${pm} not found in PATH — installing via npm…`);
  await spawnStreaming('npm', ['install', '-g', pm], process.cwd(), log);

  const resolved = resolveBin(pm);
  if (resolved) {
    log('info', `✓ ${pm} installed: ${resolved}`);
    return resolved;
  }
  // Best-effort: return the name and let the OS try
  log('warn', `Could not resolve absolute path for ${pm} after install — using bare name`);
  return pm;
}

// ── Directory tree (2 levels deep) ───────────────────────────────────────────

async function listTree(dir, log, depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

  // Sort: dirs first, then files, skip .git and node_modules
  const skip = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__']);
  entries = entries.filter((e) => !skip.has(e.name)).sort((a, b) => {
    if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
    return a.isDirectory() ? -1 : 1;
  });

  for (const e of entries) {
    const prefix = '  '.repeat(depth) + (e.isDirectory() ? '📁 ' : '📄 ');
    log('info', `${prefix}${e.name}`, 'stdout');
    if (e.isDirectory() && depth < maxDepth) {
      await listTree(path.join(dir, e.name), log, depth + 1, maxDepth);
    }
  }
}

// ── Stream Kudu build log lines while deployment runs ────────────────────────

async function streamKuduLogs(profile, deploymentId, log, deadline, uploadedAt) {
  const seen = new Set();
  let deployment = null;

  // When we have no deployment ID we fall back to /latest.
  // Add a short initial delay so Kudu has time to register the new deployment
  // and we don't immediately read the *previous* deployment's success status.
  if (!deploymentId) {
    log('info', 'No deployment ID returned — polling /latest (waiting 8 s for Kudu to register)…');
    await new Promise((r) => setTimeout(r, 8_000));
  }

  while (Date.now() < deadline) {
    const statusPath = deploymentId
      ? `/api/deployments/${encodeURIComponent(deploymentId)}`
      : '/api/deployments/latest';

    const statusRes = await kuduRequest(profile, 'GET', statusPath).catch(() => null);
    if (statusRes?.status >= 200 && statusRes?.status < 300) {
      const d = statusRes.data;
      // Guard against a stale /latest entry from a *previous* deployment:
      // only accept it if its start_time is after our upload, or if we have
      // an explicit deploymentId (no ambiguity).
      if (deploymentId || !uploadedAt) {
        deployment = d;
      } else {
        const depTime = d?.start_time ? new Date(d.start_time).getTime() : 0;
        if (depTime >= uploadedAt - 5_000) {
          deployment = d;
        }
        // else: stale entry, keep waiting
      }
    }

    const logPath = deploymentId
      ? `/api/deployments/${encodeURIComponent(deploymentId)}/log`
      : '/api/deployments/latest/log';

    const logRes = await kuduRequest(profile, 'GET', logPath).catch(() => null);
    if (logRes?.status === 200 && Array.isArray(logRes.data)) {
      for (const entry of logRes.data) {
        if (entry.message && !seen.has(entry.message)) {
          seen.add(entry.message);
          log(/error|fail/i.test(entry.message) ? 'error' : 'info', entry.message, 'stdout');
          if (entry.details_url) {
            const dp = entry.details_url.replace(/^https?:\/\/[^/]+/, '');
            const dr = await kuduRequest(profile, 'GET', dp).catch(() => null);
            if (dr?.status === 200 && Array.isArray(dr.data)) {
              for (const d of dr.data) {
                if (d.message && !seen.has(d.message)) {
                  seen.add(d.message);
                  log(/error|fail/i.test(d.message) ? 'error' : 'info', `  └─ ${d.message}`, 'stdout');
                }
              }
            }
          }
        }
      }
    }

    const status = parseDeploymentStatus(deployment);
    if (status === 'success') return { status: 'success', deployment };
    if (status === 'failed')  return { status: 'failed',  deployment };
    await new Promise((r) => setTimeout(r, LOG_POLL_INTERVAL_MS));
  }
  return { status: 'timeout', deployment };
}

// ── Application startup logs ──────────────────────────────────────────────────

async function getKuduAppLogs(profile) {
  try {
    const r = await kuduRequest(profile, 'GET', '/api/vfs/LogFiles/Application/', { responseType: 'json' });
    if (r.status !== 200 || !Array.isArray(r.data)) return '';
    const files = r.data.filter((f) => f.name?.endsWith('.txt'))
      .sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
    if (!files.length) return '';
    const lr = await kuduRequest(profile, 'GET', `/api/vfs/LogFiles/Application/${files[0].name}`, { responseType: 'text' });
    return lr.status === 200 ? String(lr.data || '').slice(-8000) : '';
  } catch { return ''; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * @param {object}   options
 * @param {string}   options.resourceGroup
 * @param {string}   options.name
 * @param {string}   options.repoUrl
 * @param {string}   [options.branch]
 * @param {string}   [options.githubToken]
 * @param {string}   [options.rootDir]        – sub-directory within the repo to deploy (e.g. "artifacts/api-server")
 * @param {string}   [options.startCommand]
 * @param {boolean}  [options.provision]      – when true, create RG/plan/app before deploying
 * @param {string}   [options.location]       – Azure region (used when provision=true)
 * @param {string}   [options.planName]       – plan name override (used when provision=true)
 * @param {string}   [options.planSku]        – plan SKU (used when provision=true, default B1)
 * @param {string}   [options.runtimeStack]   – linuxFxVersion (used when provision=true)
 * @param {Function} [options.log]   (level, message, stream, step) => void
 */
async function deployToAppService(options) {
  const {
    resourceGroup,
    name,
    repoUrl,
    branch       = 'main',
    githubToken  = '',
    rootDir      = '',
    startCommand = '',
    provision    = false,
    location     = 'eastus',
    planName     = '',
    planSku      = 'B1',
    runtimeStack = 'NODE|18-lts',
    log: onLog   = () => {},
  } = options;

  const logs = [];
  let currentStep = '';

  const log = (level, message, stream = 'info') => {
    const entry = { level, message, ts: new Date(), stream, step: currentStep };
    logs.push(entry);
    onLog(level, message, stream, currentStep);
  };

  let tempDir;
  try {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'firebox-azure-'));

    const repoDir = path.join(tempDir, 'repo');
    const zipPath = path.join(tempDir, 'deploy.zip');

    // ── 0. Provision (optional) ─────────────────────────────────────────────
    if (provision) {
      currentStep = STEPS.PROVISION;
      log('info', `Provisioning Azure App Service "${name}"…`);
      await provisionAppService({ resourceGroup, name, location, planName, planSku, runtimeStack }, log);
      log('info', '✓ App Service provisioned');
    }

    // ── 1. Clone ────────────────────────────────────────────────────────────
    currentStep = STEPS.CLONE;
    log('info', `Cloning  ${repoUrl}  (branch: ${branch})…`);

    const cloneEnv = githubToken
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${githubToken}` }
      : {};

    await spawnStreaming(
      'git',
      ['clone', '--progress', '--depth', '1', '--branch', branch, repoUrl, repoDir],
      tempDir, log, cloneEnv
    );
    log('info', '✓ Repository cloned');

    // ── Resolve deployment path (monorepo support) ──────────────────────────
    const normalizedRootDir = rootDir ? rootDir.replace(/^\/|\/$/g, '') : '';
    const deployPath = normalizedRootDir ? path.join(repoDir, normalizedRootDir) : repoDir;

    if (normalizedRootDir) {
      log('info', `Deployment root: ${normalizedRootDir}`);
      // Fail immediately if the specified sub-directory does not exist
      const rootDirExists = await fs.access(deployPath).then(() => true).catch(() => false);
      if (!rootDirExists) {
        throw deploymentError(
          `rootDir "${normalizedRootDir}" does not exist in the repository. ` +
          `Check that the path is correct and present on branch "${branch}".`
        );
      }
    }

    // ── 2. Inspect ──────────────────────────────────────────────────────────
    currentStep = STEPS.INSPECT;
    log('info', '');
    log('info', '── Repository contents ───────────────────────────────────');
    await listTree(deployPath, log);
    log('info', '──────────────────────────────────────────────────────────');

    // Read package.json
    const pkgPath = path.join(deployPath, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      log('info', `package.json  →  name: ${pkg.name || '(unnamed)'},  version: ${pkg.version || '?'}`);
      if (pkg.scripts?.start) log('info', `  scripts.start: ${pkg.scripts.start}`);
      if (pkg.scripts?.build) log('info', `  scripts.build: ${pkg.scripts.build}`);
    } catch {
      throw deploymentError(
        `No valid package.json found in "${normalizedRootDir || 'repository root'}". ` +
        (normalizedRootDir ? `Verify that rootDir "${normalizedRootDir}" points to a Node.js package.` : '')
      );
    }

    // Resolve startup command
    let startCmd = startCommand;
    if (!startCmd) {
      startCmd = pkg.scripts?.start || (pkg.main ? `node ${pkg.main}` : '');
      if (!startCmd) {
        // Probe common Node.js entry points in precedence order
        const candidates = [
          'server.js',
          'index.js',
          'app.js',
          'main.js',
          'src/index.js',
          'src/server.js',
          'src/app.js',
          'src/main.js',
        ];
        for (const candidate of candidates) {
          const exists = await fs.access(path.join(deployPath, candidate)).then(() => true).catch(() => false);
          if (exists) {
            startCmd = `node ${candidate}`;
            break;
          }
        }
        if (!startCmd) {
          throw deploymentError(
            'Cannot determine startup command. ' +
            'Add scripts.start to package.json or pass a startCommand. ' +
            `Checked: ${candidates.join(', ')}.`
          );
        }
      }
    }
    log('info', `Startup command: ${startCmd}`);

    // Detect package manager
    const [hasPnpm, hasYarn] = await Promise.all([
      fs.access(path.join(deployPath, 'pnpm-lock.yaml')).then(() => true).catch(() => false),
      fs.access(path.join(deployPath, 'yarn.lock')).then(() => true).catch(() => false),
    ]);
    const pm = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm';
    log('info', `Package manager: ${pm}`);

    // ── 3. Install ──────────────────────────────────────────────────────────
    currentStep = STEPS.INSTALL;
    log('info', '');
    const pmBin = await ensurePackageManager(pm, log);
    log('info', `Running ${pm} install…`);
    const installArgs = pm === 'pnpm' ? ['install', '--frozen-lockfile']
                      : pm === 'yarn' ? ['install', '--frozen-lockfile']
                      : ['install'];
    await spawnStreaming(pmBin, installArgs, deployPath, log);
    log('info', '✓ Dependencies installed');

    // ── 4. Build ────────────────────────────────────────────────────────────
    currentStep = STEPS.BUILD;
    if (pkg.scripts?.build) {
      log('info', '');
      log('info', `Running build: ${pkg.scripts.build}`);
      await spawnStreaming(pmBin, ['run', 'build'], deployPath, log);
      log('info', '✓ Build complete');
    } else {
      log('info', 'No build script — skipping');
    }

    // ── 5. Package ──────────────────────────────────────────────────────────
    currentStep = STEPS.PACKAGE;
    log('info', '');
    log('info', 'Creating deployment ZIP (excluding node_modules, .git)…');

    // Stage: copy without node_modules and .git
    const stageDir = path.join(tempDir, 'stage');
    await fs.cp(deployPath, stageDir, {
      recursive: true,
      filter: (src) => {
        const parts = src.split(path.sep);
        return !parts.includes('.git') && !parts.includes('node_modules');
      },
    });

    await spawnStreaming('zip', ['-qr', zipPath, '.'], stageDir, log);
    const { size } = await fs.stat(zipPath);
    log('info', `✓ ZIP created  (${(size / 1024).toFixed(1)} KB)`);

    // ── 6. Get Publishing Credentials (with retry — Azure takes time after creation) ──
    currentStep = STEPS.CREDENTIALS;
    log('info', '');
    log('info', 'Fetching Azure publishing credentials…');
    if (provision) log('info', 'Azure may take up to 30 seconds.');

    let profile;
    for (let attempt = 1; attempt <= CRED_MAX_ATTEMPTS; attempt++) {
      log('info', `Attempt ${attempt}/${CRED_MAX_ATTEMPTS}…`);
      try {
        profile = parsePublishProfile(await azure.getPublishingProfile(resourceGroup, name));
        log('info', '✓ Publishing profile is now available.');
        break;
      } catch (credErr) {
        if (attempt === CRED_MAX_ATTEMPTS) throw credErr;
        const is404 = credErr.azureStatus === 404 || /404|not found|not ready/i.test(credErr.message);
        if (is404) {
          log('info', `Publishing profile not ready yet (404). Waiting ${CRED_RETRY_MS / 1000} seconds...`);
        } else {
          log('warn', `${credErr.message} — retrying in ${CRED_RETRY_MS / 1000}s…`);
        }
        await new Promise((r) => setTimeout(r, CRED_RETRY_MS));
      }
    }
    log('info', `✓ Kudu endpoint: ${profile.publishUrl}`);

    // Configure Azure app settings
    const currentSettings = await azure.getAppSettings(resourceGroup, name);
    await azure.updateAppSettings(resourceGroup, name, {
      ...currentSettings,
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'false',   // we already built locally
      WEBSITE_RUN_FROM_PACKAGE: '0',
    });
    await azure.updateSiteConfig(resourceGroup, name, { appCommandLine: startCmd });
    log('info', `✓ Startup command set: ${startCmd}`);

    // ── 7. Upload ────────────────────────────────────────────────────────────
    currentStep = STEPS.UPLOAD;
    log('info', '');
    log('info', 'Uploading ZIP to Azure via Kudu Zip Deploy…');
    const zipBuffer = await fs.readFile(zipPath);
    const upload = await kuduRequest(profile, 'POST', '/api/zipdeploy?isAsync=true', {
      timeout: 120_000,
      headers: { 'Content-Type': 'application/zip' },
      data: zipBuffer,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const deploymentId = extractDeploymentId(upload.headers?.location, upload.data);

    if (upload.status < 200 || upload.status >= 300) {
      throw deploymentError(
        `Azure rejected the upload (HTTP ${upload.status}).\n${responseBody(upload.data)}`,
        { azureStatus: upload.status, azureBody: upload.data }
      );
    }
    const uploadedAt = Date.now();
    log('info', `✓ Upload accepted${deploymentId ? `  (deployment id: ${deploymentId})` : ''}`);

    // ── 8. Deployment Status ─────────────────────────────────────────────────
    currentStep = STEPS.POLL;
    log('info', '');
    log('info', 'Waiting for Azure to deploy the package…');

    const { status: buildStatus, deployment } = await streamKuduLogs(
      profile, deploymentId, log, deadline, uploadedAt
    );

    if (buildStatus === 'timeout') {
      throw deploymentError(
        `Azure deployment timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 60_000)} minutes.`,
        { deploymentId, logs }
      );
    }

    if (buildStatus === 'failed') {
      const appLogs = await getKuduAppLogs(profile).catch(() => '');
      if (appLogs) log('error', `── App startup logs ──\n${appLogs}`, 'stderr');
      const msg = [deployment?.message, deployment?.status_text, appLogs ? '\n(See startup logs above)' : '']
        .filter(Boolean).join('\n') || 'Azure deployment failed — see logs above.';
      throw deploymentError(msg, { deploymentId, logs });
    }

    log('info', '✓ Azure deployment complete');

    // ── 9. Verify Application ────────────────────────────────────────────────
    currentStep = STEPS.STARTUP;
    const appUrl  = `https://${name}.azurewebsites.net/`;
    const startDl = Date.now() + APP_STARTUP_TIMEOUT_MS;
    log('info', '');
    log('info', `Waiting for app to start at ${appUrl}…`);

    // Azure placeholder patterns — returned as 200 when the app was never deployed
    // or the runtime hasn't started yet.
    const AZURE_PLACEHOLDER = /your web app is running and waiting for your content|hey, node developers!|welcome to app service|this is your default web page|oryx build|microsoft azure app service/i;

    let lastFailure = '';
    while (Date.now() < startDl) {
      try {
        const r    = await axios.get(appUrl, { timeout: 15_000, responseType: 'text', validateStatus: () => true });
        const body = String(r.data || '');
        const bodyLen = body.length;

        log('info', `  → HTTP ${r.status}  (${bodyLen} bytes)`);

        if (r.status >= 200 && r.status < 300) {
          if (AZURE_PLACEHOLDER.test(body)) {
            // Azure returned its "not deployed yet" placeholder page
            lastFailure = 'Azure placeholder page — app not deployed yet';
            log('warn', `  App is returning Azure's placeholder page — waiting…`);
          } else if (bodyLen === 0) {
            // Empty 200 — app may have started but crashed before sending headers
            lastFailure = 'Empty response body (HTTP 200)';
            log('warn', '  App returned an empty 200 — may still be starting…');
          } else {
            log('info', `✓ Application is live — HTTP ${r.status}`);
            return { success: true, deploymentId, url: appUrl, httpStatus: r.status, logs };
          }
        } else if (r.status === 503 || r.status === 502) {
          // Azure gateway errors — app hasn't started yet
          lastFailure = `HTTP ${r.status} (app not ready)`;
          log('warn', `  HTTP ${r.status} — app not ready yet, waiting…`);
        } else if (r.status === 404 || r.status === 403) {
          // 4xx from Azure means the app process isn't running at all
          // (a running app would serve its own 404/403, not Azure's)
          const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
          lastFailure = `HTTP ${r.status} — app process not running (${snippet || 'no body'})`;
          log('error', `  HTTP ${r.status} — app is not running. Azure response: ${snippet || '(empty)'}`);
          // Don't keep waiting on a definitive "not running" from Azure — fail fast
          const appLogs = await getKuduAppLogs(profile).catch(() => '');
          if (appLogs) log('error', `── App startup logs ──\n${appLogs}`, 'stderr');
          throw deploymentError(
            `App deployed but is not running (HTTP ${r.status}).\n` +
            `Azure returned: ${snippet || '(empty body)'}\n` +
            (appLogs ? 'See startup logs above for the crash reason.' : 'Check application logs in the Azure portal.'),
            { deploymentId, logs }
          );
        } else {
          lastFailure = `HTTP ${r.status}`;
          log('warn', `  HTTP ${r.status} — waiting…`);
        }
      } catch (e) {
        if (e.failedStep) throw e;   // our own deploymentError — rethrow
        lastFailure = e.message;
        log('warn', `  Probe failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    const appLogs = await getKuduAppLogs(profile).catch(() => '');
    if (appLogs) log('error', `── App startup logs ──\n${appLogs}`, 'stderr');
    throw deploymentError(
      `App did not start within ${Math.round(APP_STARTUP_TIMEOUT_MS / 60_000)} minutes.\nLast: ${lastFailure}`,
      { deploymentId, logs }
    );

  } catch (err) {
    err.failedStep = err.failedStep || currentStep;
    if (!err.logs) err.logs = logs;
    throw err;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { deployToAppService, parsePublishProfile, parseDeploymentStatus, STEPS };
