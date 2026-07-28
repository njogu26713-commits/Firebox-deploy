/**
 * Azure App Service deployment pipeline.
 *
 * Sends the repository URL directly to Azure Kudu's external-git deploy
 * endpoint (/deploy). Azure clones the repo, runs Oryx build, and deploys
 * the app entirely on Azure's infrastructure. Firebox streams the Kudu
 * build logs back to the browser in real time.
 *
 * Pipeline steps:
 *   1. Get Publishing Credentials  — fetch Kudu URL + basic-auth credentials
 *   2. Configure App Settings      — set startup command + build env vars
 *   3. Trigger Deployment          — POST repo URL to Kudu /deploy
 *   4. Building on Azure           — stream Kudu log lines while Azure builds
 *   5. Verify Application          — poll app URL until it responds
 */

const axios  = require('axios');
const azure  = require('./azure.service');

const POLL_INTERVAL_MS        = 3_000;
const LOG_POLL_INTERVAL_MS    = 2_000;
const DEFAULT_TIMEOUT_MS      = 15 * 60 * 1_000;   // 15 min build timeout
const APP_STARTUP_TIMEOUT_MS  = 3  * 60 * 1_000;   // 3 min startup timeout

// ── Named pipeline steps (must match PIPELINE_STEPS in azure.js) ────────────
const STEPS = {
  CREDENTIALS: 'Get Publishing Credentials',
  CONFIGURE:   'Configure App Settings',
  TRIGGER:     'Trigger Deployment',
  BUILD:       'Building on Azure',
  STARTUP:     'Verify Application',
};

// ── XML helpers ───────────────────────────────────────────────────────────────

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parsePublishProfile(xml) {
  const profiles = [...String(xml || '').matchAll(/<publishProfile\b([^>]*)\/?>/gi)];
  const attrs = {};
  for (const [, rawAttrs] of profiles) {
    for (const match of rawAttrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[match[1]] = decodeXml(match[2]);
    }
    if (attrs.publishMethod === 'MSDeploy' || attrs.publishUrl) break;
  }

  if (!attrs.publishUrl || !attrs.userName || !attrs.userPWD) {
    throw deploymentError('Azure publishing profile did not contain Kudu deployment credentials');
  }

  const publishUrl = attrs.publishUrl.startsWith('http')
    ? attrs.publishUrl
    : `https://${attrs.publishUrl}`;
  return {
    publishUrl: publishUrl.replace(/\/+$/, ''),
    userName:   attrs.userName,
    password:   attrs.userPWD,
  };
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function deploymentError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function responseBody(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  try { return JSON.stringify(response, null, 2); } catch { return String(response); }
}

// ── Kudu HTTP helper ──────────────────────────────────────────────────────────

async function kuduRequest(profile, method, requestPath, options = {}) {
  const url = `${profile.publishUrl}${requestPath}`;
  try {
    return await axios({
      method,
      url,
      auth:             { username: profile.userName, password: profile.password },
      timeout:          options.timeout || 30_000,
      responseType:     options.responseType || 'json',
      headers:          options.headers,
      data:             options.data,
      validateStatus:   () => true,
    });
  } catch (err) {
    throw deploymentError(`Kudu request failed (${method} ${requestPath}): ${err.message}`, { cause: err });
  }
}

// ── Deployment status helpers ─────────────────────────────────────────────────

function parseDeploymentStatus(deployment) {
  const raw = deployment?.status;
  if (typeof raw === 'number') {
    if (raw === 4) return 'success';
    if (raw === 3) return 'failed';
    return 'pending';
  }
  const s = String(raw || deployment?.status_text || '').toLowerCase();
  if (['success', 'successful', 'succeeded', 'done', 'complete', 'completed'].includes(s)) return 'success';
  if (['failed', 'failure', 'error', 'rejected'].includes(s)) return 'failed';
  return 'pending';
}

function extractDeploymentId(location, data) {
  const m = String(location || '').match(/\/deployments\/([^/?#]+)/i);
  return m?.[1] || data?.id || data?.deploymentId || null;
}

// ── Log streaming helper ──────────────────────────────────────────────────────

/**
 * Polls the Kudu deployment log endpoint and emits new lines via the log
 * callback until the deployment reaches a terminal state.
 *
 * Returns the final deployment object.
 */
async function streamKuduBuildLogs(profile, deploymentId, log, deadline) {
  const seenMessages = new Set();
  let deployment = null;

  while (Date.now() < deadline) {
    // ── Fetch deployment status ──
    const statusRes = await kuduRequest(
      profile, 'GET',
      deploymentId
        ? `/api/deployments/${encodeURIComponent(deploymentId)}`
        : '/api/deployments/latest'
    );

    if (statusRes.status >= 200 && statusRes.status < 300) {
      deployment = statusRes.data;
    }

    // ── Fetch and emit new log lines ──
    const logRes = await kuduRequest(
      profile, 'GET',
      deploymentId
        ? `/api/deployments/${encodeURIComponent(deploymentId)}/log`
        : '/api/deployments/latest/log'
    ).catch(() => null);

    if (logRes?.status === 200 && Array.isArray(logRes.data)) {
      for (const entry of logRes.data) {
        const msg = entry.message || '';
        if (msg && !seenMessages.has(msg)) {
          seenMessages.add(msg);
          const level = /error|fail/i.test(msg) ? 'error' : 'info';
          log(level, msg, 'stdout');

          // Also fetch detail sub-entries for this log line
          if (entry.details_url) {
            try {
              const detailPath = entry.details_url.replace(/^https?:\/\/[^/]+/, '');
              const detailRes  = await kuduRequest(profile, 'GET', detailPath);
              if (detailRes.status === 200 && Array.isArray(detailRes.data)) {
                for (const d of detailRes.data) {
                  if (d.message && !seenMessages.has(d.message)) {
                    seenMessages.add(d.message);
                    const dlevel = /error|fail/i.test(d.message) ? 'error' : 'info';
                    log(dlevel, `  └─ ${d.message}`, 'stdout');
                  }
                }
              }
            } catch { /* ignore */ }
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

// ── Get application startup logs on failure ───────────────────────────────────

async function getKuduAppLogs(profile) {
  try {
    const res = await kuduRequest(profile, 'GET', '/api/vfs/LogFiles/Application/', { responseType: 'json' });
    if (res.status !== 200 || !Array.isArray(res.data)) return '';
    const files = res.data
      .filter((f) => f.name?.endsWith('.txt'))
      .sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
    if (!files.length) return '';
    const logRes = await kuduRequest(profile, 'GET', `/api/vfs/LogFiles/Application/${files[0].name}`, { responseType: 'text' });
    return logRes.status === 200 ? String(logRes.data || '').slice(-8000) : '';
  } catch {
    return '';
  }
}

// ── Format a clear error message from Kudu failure data ──────────────────────

function formatFailureMessage(deployment, appLogs) {
  const parts = [];

  if (deployment?.message)     parts.push(deployment.message);
  if (deployment?.status_text) parts.push(deployment.status_text);

  if (appLogs) {
    parts.push('\n── Application startup logs ──────────────────────────────────');
    parts.push(appLogs);
  }

  return parts.filter(Boolean).join('\n').trim() || 'Azure deployment failed — see logs above for details.';
}

// ── Main deploy function ──────────────────────────────────────────────────────

/**
 * Deploy a GitHub/Git repository to an Azure App Service using Kudu's
 * built-in external-git deployment. Azure clones the repo, runs Oryx build,
 * and deploys — all on Azure's infrastructure.
 *
 * @param {object}   options
 * @param {string}   options.resourceGroup
 * @param {string}   options.name            — App Service name
 * @param {string}   options.repoUrl         — public or token-authed GitHub URL
 * @param {string}   [options.branch]        — default "main"
 * @param {string}   [options.startCommand]  — e.g. "node server.js"
 * @param {Function} [options.log]           — (level, message, stream, step) => void
 */
async function deployToAppService(options) {
  const {
    resourceGroup,
    name,
    repoUrl,
    branch        = 'main',
    startCommand  = '',
    log: onLog    = () => {},
  } = options;

  const logs        = [];
  let   currentStep = '';

  const log = (level, message, stream = 'info') => {
    const entry = { level, message, ts: new Date(), stream, step: currentStep };
    logs.push(entry);
    onLog(level, message, stream, currentStep);
  };

  try {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;

    // ── Step 1: Get Publishing Credentials ───────────────────────────────────
    currentStep = STEPS.CREDENTIALS;
    log('info', 'Fetching Azure App Service publishing credentials…');
    const profileXml = await azure.getPublishingProfile(resourceGroup, name);
    const profile    = parsePublishProfile(profileXml);
    log('info', `✓ Kudu endpoint: ${profile.publishUrl}`);

    // ── Step 2: Configure App Settings ──────────────────────────────────────
    currentStep = STEPS.CONFIGURE;
    log('info', 'Configuring Azure app settings and build options…');
    const currentSettings = await azure.getAppSettings(resourceGroup, name);
    await azure.updateAppSettings(resourceGroup, name, {
      ...currentSettings,
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'true',
      ENABLE_ORYX_BUILD:              'true',
    });

    if (startCommand) {
      await azure.updateSiteConfig(resourceGroup, name, { appCommandLine: startCommand });
      log('info', `✓ Startup command set: ${startCommand}`);
    } else {
      log('info', '✓ No custom startup command — Azure will auto-detect (Oryx)');
    }

    // ── Step 3: Trigger Deployment ───────────────────────────────────────────
    currentStep = STEPS.TRIGGER;
    log('info', `Sending repository to Azure: ${repoUrl} (branch: ${branch})`);

    const triggerRes = await kuduRequest(profile, 'POST', '/deploy', {
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
      data: {
        url:        repoUrl,
        branch,
        is_async:   true,
        format:     'basic',
        deployer:   'FireboxDeploy',
        author:     'Firebox Deploy',
      },
    });

    if (triggerRes.status !== 202 && triggerRes.status !== 200) {
      const body = responseBody(triggerRes.data);
      throw deploymentError(
        `Azure rejected the deployment request (HTTP ${triggerRes.status}).\n${body}`,
        { azureStatus: triggerRes.status, azureBody: triggerRes.data }
      );
    }

    const deploymentId = extractDeploymentId(triggerRes.headers?.location, triggerRes.data);
    log('info', `✓ Deployment triggered${deploymentId ? ` (id: ${deploymentId})` : ''}`);

    // ── Step 4: Building on Azure ─────────────────────────────────────────────
    currentStep = STEPS.BUILD;
    log('info', 'Azure is cloning the repository and building the application…');
    log('info', '(Azure build logs will appear below as they arrive)');

    const { status: buildStatus, deployment } = await streamKuduBuildLogs(
      profile, deploymentId, log, deadline
    );

    if (buildStatus === 'timeout') {
      throw deploymentError(
        `Azure build timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 60_000)} minutes.\n` +
        `Last known status: ${deployment?.status_text || 'unknown'}`,
        { deploymentId, logs }
      );
    }

    if (buildStatus === 'failed') {
      // Gather app startup logs in case the app itself crashed
      const appLogs = await getKuduAppLogs(profile).catch(() => '');
      if (appLogs) log('error', `── Application logs ──────────────────\n${appLogs}`, 'stderr');

      const msg = formatFailureMessage(deployment, appLogs);
      throw deploymentError(msg, {
        azureStatus: triggerRes.status,
        azureBody:   deployment,
        deploymentId,
        logs,
      });
    }

    log('info', '✓ Azure build completed successfully');

    // ── Step 5: Verify Application ────────────────────────────────────────────
    currentStep = STEPS.STARTUP;
    const appUrl   = `https://${name}.azurewebsites.net/`;
    const startDl  = Date.now() + APP_STARTUP_TIMEOUT_MS;
    log('info', `Waiting for application to start at ${appUrl}…`);

    let lastFailure = '';
    while (Date.now() < startDl) {
      try {
        const res  = await axios.get(appUrl, { timeout: 15_000, responseType: 'text', validateStatus: () => true });
        const body = String(res.data || '');
        if (/Your web app is running and waiting for your content/i.test(body)) {
          lastFailure = 'Azure placeholder page still showing — app has not deployed yet';
        } else if (res.status < 500) {
          log('info', `✓ Application is live — HTTP ${res.status}`);
          return { success: true, deploymentId, url: appUrl, httpStatus: res.status, logs };
        } else {
          lastFailure = `Application returned HTTP ${res.status}`;
          log('warn', `Startup: HTTP ${res.status} — waiting…`);
        }
      } catch (err) {
        lastFailure = err.message;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Startup timed out — fetch app logs before throwing
    const appLogs = await getKuduAppLogs(profile).catch(() => '');
    if (appLogs) log('error', `── Application logs ──────────────────\n${appLogs}`, 'stderr');

    throw deploymentError(
      `Application did not start within ${Math.round(APP_STARTUP_TIMEOUT_MS / 60_000)} minutes.\n` +
      `Last response: ${lastFailure || 'no response'}`,
      { deploymentId, logs }
    );

  } catch (err) {
    err.failedStep = err.failedStep || currentStep;
    if (!err.logs) err.logs = logs;
    throw err;
  }
}

module.exports = {
  deployToAppService,
  parsePublishProfile,
  parseDeploymentStatus,
  STEPS,
};
