/**
 * Explicit Azure App Service deployment pipeline.
 *
 * Azure source-control configuration only schedules a build; it does not
 * guarantee that a repository is cloned or that an artifact reaches
 * /home/site/wwwroot. This pipeline owns those steps and does not report
 * success until Kudu has completed the zip deployment and the deployed
 * package can be read back from the site.
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');

const azure = require('./azure.service');
const {
  detectPackageManager,
  getPackageManagerCommands,
} = require('./package-manager.service');

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const APP_STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

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
    throw new Error('Azure publishing profile did not contain Kudu deployment credentials');
  }

  const publishUrl = attrs.publishUrl.startsWith('http')
    ? attrs.publishUrl
    : `https://${attrs.publishUrl}`;
  return {
    publishUrl: publishUrl.replace(/\/+$/, ''),
    userName: attrs.userName,
    password: attrs.userPWD,
  };
}

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

async function runCommand(command, args, cwd, log, extraEnv = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: '1', ...extraEnv },
    });
    if (result.stdout?.trim()) log('info', result.stdout.trim());
    if (result.stderr?.trim()) log('info', result.stderr.trim());
    return result;
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw deploymentError(
      `${command} ${args.join(' ')} failed${output ? `:\n${output}` : `: ${err.message}`}`,
      { cause: err, commandOutput: output }
    );
  }
}

async function runShell(command, cwd, log) {
  try {
    const result = await execAsync(command, {
      cwd,
      shell: '/bin/sh',
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    });
    if (result.stdout?.trim()) log('info', result.stdout.trim());
    if (result.stderr?.trim()) log('info', result.stderr.trim());
    return result;
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw deploymentError(
      `Command failed: ${command}${output ? `\n${output}` : `: ${err.message}`}`,
      { cause: err, commandOutput: output }
    );
  }
}

async function hasCommand(command) {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${shellQuote(command)}`]);
    return true;
  } catch {
    return false;
  }
}

function normalizeRootDir(rootDir) {
  const value = String(rootDir || '.').trim() || '.';
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error('rootDir must be a relative directory inside the repository');
  }
  return value;
}

function parseDeploymentStatus(deployment) {
  const raw = deployment?.status;
  if (typeof raw === 'number') {
    // Kudu: 0=pending, 1=building, 2=deploying, 3=failed, 4=success.
    if (raw === 4) return 'success';
    if (raw === 3) return 'failed';
    return 'pending';
  }
  const status = String(raw || deployment?.status_text || '').toLowerCase();
  if (['success', 'successful', 'succeeded', 'done', 'complete', 'completed'].includes(status)) {
    return 'success';
  }
  if (['failed', 'failure', 'error', 'rejected'].includes(status)) return 'failed';
  return 'pending';
}

function extractDeploymentId(location, data) {
  const fromLocation = String(location || '').match(/\/deployments\/([^/?#]+)/i);
  return fromLocation?.[1] || data?.id || data?.deploymentId || null;
}

async function kuduRequest(profile, method, requestPath, options = {}) {
  const url = `${profile.publishUrl}${requestPath}`;
  try {
    return await axios({
      method,
      url,
      auth: { username: profile.userName, password: profile.password },
      timeout: options.timeout || 30_000,
      responseType: options.responseType || 'json',
      headers: options.headers,
      data: options.data,
      maxContentLength: options.maxContentLength,
      maxBodyLength: options.maxBodyLength,
      validateStatus: () => true,
    });
  } catch (err) {
    throw deploymentError(`Azure Kudu request failed: ${err.message}`, { cause: err });
  }
}

async function readDeploymentDetails(profile, deploymentId) {
  if (!deploymentId) return null;
  const response = await kuduRequest(profile, 'GET', `/api/deployments/${encodeURIComponent(deploymentId)}`);
  return response.status >= 200 && response.status < 300 ? response.data : null;
}

async function readDeploymentLog(profile, deploymentId) {
  if (!deploymentId) return '';
  const response = await kuduRequest(profile, 'GET', `/api/deployments/${encodeURIComponent(deploymentId)}/log`);
  return response.status >= 200 && response.status < 300 ? responseBody(response.data) : '';
}

function formatKuduFailure(response, deployment, deploymentLog) {
  const parts = [
    `Azure deployment failed${response?.status ? ` (HTTP ${response.status})` : ''}.`,
    deployment?.message,
    deployment?.status_text,
    deployment?.complete ? `complete=${deployment.complete}` : '',
    deploymentLog ? `Deployment log:\n${deploymentLog}` : '',
    response?.data && response.status >= 400 ? `Azure response:\n${responseBody(response.data)}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

async function verifyPackage(profile, log) {
  const response = await kuduRequest(profile, 'GET', '/api/vfs/site/wwwroot/package.json', {
    responseType: 'text',
  });
  if (response.status !== 200) {
    throw deploymentError(
      `Deployment verification failed: package.json was not found in /home/site/wwwroot (HTTP ${response.status}).\n` +
      `Azure response:\n${responseBody(response.data)}`,
      { azureStatus: response.status, azureBody: response.data }
    );
  }

  try {
    JSON.parse(response.data);
  } catch {
    throw deploymentError('Deployment verification failed: /home/site/wwwroot/package.json is not valid JSON');
  }
  log('info', '✓ Verified package.json in /home/site/wwwroot');
}

async function verifyApplicationRunning(name, log) {
  const timeoutMs = Number(process.env.AZURE_APP_STARTUP_TIMEOUT_MS) || APP_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const url = `https://${name}.azurewebsites.net/`;
  let lastFailure = '';

  log('info', `Checking ${url} for a live application response…`);
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(url, {
        timeout: 15_000,
        responseType: 'text',
        validateStatus: () => true,
      });
      const body = String(response.data || '');
      if (/Your web app is running and waiting for your content/i.test(body)) {
        lastFailure = 'Azure is still serving its default placeholder page';
      } else if (response.status < 500) {
        log('info', `✓ Application responded with HTTP ${response.status}; default placeholder is gone`);
        return { url, status: response.status };
      } else {
        lastFailure = `Application returned HTTP ${response.status}`;
      }
    } catch (err) {
      lastFailure = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw deploymentError(
    `Application startup verification failed for ${url}: ${lastFailure || 'no response'}`
  );
}

/**
 * Deploy a Git repository to an existing Azure App Service.
 *
 * @param {object} options
 * @param {string} options.resourceGroup
 * @param {string} options.name
 * @param {string} options.repoUrl
 * @param {string} options.branch
 * @param {string} [options.githubToken]
 * @param {string} [options.rootDir]
 * @param {string} [options.buildCommand]
 * @param {string} [options.startCommand]
 * @param {(level: string, message: string) => void} [options.log]
 */
async function deployToAppService(options) {
  const {
    resourceGroup,
    name,
    repoUrl,
    branch = 'main',
    githubToken = '',
    rootDir: requestedRootDir = '.',
    buildCommand: requestedBuildCommand = '',
    startCommand: requestedStartCommand = '',
    log: onLog = () => {},
  } = options;

  const logs = [];
  const log = (level, message) => {
    const entry = { level, message, ts: new Date() };
    logs.push(entry);
    onLog(level, message);
  };

  let tempDir;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'firebox-azure-'));
    const repoDir = path.join(tempDir, 'repo');
    const zipPath = path.join(tempDir, 'deploy.zip');

    log('info', `[1/8] Cloning repository ${repoUrl} (branch ${branch})…`);
    const cloneArgs = ['clone', '--depth', '1', '--branch', branch, repoUrl, repoDir];
    const gitEnv = githubToken
      ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${githubToken}`,
      }
      : {};
    await runCommand('git', cloneArgs, tempDir, log, gitEnv);
    log('info', '✓ Repository cloned successfully');

    const deployRoot = normalizeRootDir(requestedRootDir);
    const sourceDir = path.resolve(repoDir, deployRoot);
    if (!sourceDir.startsWith(`${path.resolve(repoDir)}${path.sep}`) && sourceDir !== path.resolve(repoDir)) {
      throw new Error('rootDir resolves outside the cloned repository');
    }
    const packagePath = path.join(sourceDir, 'package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    } catch (err) {
      throw deploymentError(
        `No valid package.json found in the deployment root ${deployRoot}: ${err.message}`,
        { cause: err }
      );
    }

    const [pnpmLock, yarnLock, npmLock] = await Promise.all(
      ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].map(async (file) => {
        try { await fs.access(path.join(sourceDir, file)); return true; } catch { return false; }
      })
    );
    const packageManager = detectPackageManager({ pnpm: pnpmLock, yarn: yarnLock, npm: npmLock });
    const commands = getPackageManagerCommands(packageManager, {
      hasBuildScript: Boolean(packageJson.scripts?.build),
      buildCommand: requestedBuildCommand,
      startCommand: requestedStartCommand,
    });
    if (pnpmLock) log('info', 'Detected pnpm-lock.yaml; dependency installation will use pnpm --frozen-lockfile');
    log('info', `Using ${packageManager} for this application`);

    const packageTool = packageManager === 'pnpm'
      ? (await hasCommand('pnpm') ? 'pnpm' : 'corepack')
      : packageManager;
    if (packageManager === 'pnpm' && packageTool === 'corepack') {
      log('info', 'pnpm is not on PATH; using Corepack to run pnpm');
      await runShell('corepack enable', sourceDir, log);
    }

    log('info', `[2/8] Installing dependencies with ${packageTool === 'corepack' ? 'corepack pnpm' : packageTool}…`);
    const installArgs = packageManager === 'pnpm'
      ? ['install', '--frozen-lockfile']
      : ['install'];
    await runCommand(packageTool, packageManager === 'pnpm' ? ['pnpm', ...installArgs] : installArgs, sourceDir, log);
    log('info', '✓ Dependencies installed');

    if (commands.buildCommand) {
      log('info', `[3/8] Building application with: ${commands.buildCommand}`);
      await runShell(commands.buildCommand, sourceDir, log);
      log('info', '✓ Application build completed');
    } else {
      log('info', '[3/8] No build script configured; skipping application build');
    }

    let startCommand = commands.startCommand;
    if (!startCommand) {
      if (packageJson.main) startCommand = `node ${packageJson.main}`;
      else if (await fs.access(path.join(sourceDir, 'server.js')).then(() => true).catch(() => false)) {
        startCommand = 'node server.js';
      } else {
        throw new Error('No startup command found. Set a start command or add scripts.start to package.json.');
      }
    }
    log('info', `Startup command selected: ${startCommand}`);

    log('info', `[4/8] Creating deployment package from ${deployRoot}…`);
    const stageDir = path.join(tempDir, 'stage');
    await fs.cp(sourceDir, stageDir, {
      recursive: true,
      filter: (source) => {
        const parts = source.split(path.sep);
        return !parts.includes('.git') && !parts.includes('node_modules');
      },
    });
    try {
      await fs.access(path.join(stageDir, 'package.json'));
    } catch {
      throw new Error('Deployment package does not contain package.json at its root');
    }
    await runCommand('zip', ['-qr', zipPath, '.'], stageDir, log);
    const zipStat = await fs.stat(zipPath);
    log('info', `✓ Deployment package created (${zipStat.size} bytes)`);

    log('info', '[5/8] Obtaining Azure App Service publishing profile…');
    const profile = parsePublishProfile(await azure.getPublishingProfile(resourceGroup, name));
    log('info', `✓ Kudu endpoint ready: ${profile.publishUrl}`);

    log('info', '[6/8] Configuring Azure build settings and startup command…');
    const currentSettings = await azure.getAppSettings(resourceGroup, name);
    await azure.updateAppSettings(resourceGroup, name, {
      ...currentSettings,
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'true',
      ENABLE_ORYX_BUILD: 'true',
    });
    await azure.updateSiteConfig(resourceGroup, name, { appCommandLine: startCommand });
    log('info', `✓ Startup command configured: ${startCommand}`);

    log('info', '[7/8] Uploading package to Azure with Kudu Zip Deploy…');
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
      const details = deploymentId ? await readDeploymentDetails(profile, deploymentId) : null;
      const deploymentLog = deploymentId ? await readDeploymentLog(profile, deploymentId) : '';
      throw deploymentError(formatKuduFailure(upload, details, deploymentLog), {
        azureStatus: upload.status,
        azureBody: upload.data,
        deploymentId,
        deploymentLog,
        logs,
      });
    }
    log('info', `✓ Package accepted by Azure${deploymentId ? ` (deployment ${deploymentId})` : ''}`);

    log('info', '[8/8] Waiting for Azure deployment status…');
    const deadline = Date.now() + (Number(process.env.AZURE_DEPLOYMENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    let deployment;
    let deploymentResponse = upload;
    while (Date.now() < deadline) {
      if (deploymentId) {
        deploymentResponse = await kuduRequest(
          profile, 'GET', `/api/deployments/${encodeURIComponent(deploymentId)}`
        );
        deployment = deploymentResponse.status >= 200 && deploymentResponse.status < 300
          ? deploymentResponse.data
          : null;
      } else {
        deploymentResponse = await kuduRequest(profile, 'GET', '/api/deployments/latest');
        deployment = deploymentResponse.status >= 200 && deploymentResponse.status < 300
          ? deploymentResponse.data
          : null;
      }
      const status = parseDeploymentStatus(deployment);
      log('info', `Azure deployment status: ${status}${deployment?.message ? ` — ${deployment.message}` : ''}`);
      if (status === 'success') break;
      if (status === 'failed') {
        const deploymentLog = await readDeploymentLog(profile, deploymentId || deployment?.id);
        throw deploymentError(formatKuduFailure(deploymentResponse, deployment, deploymentLog), {
          azureStatus: deploymentResponse.status,
          azureBody: deployment,
          deploymentId: deploymentId || deployment?.id,
          deploymentLog,
          logs,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (parseDeploymentStatus(deployment) !== 'success') {
      const deploymentLog = await readDeploymentLog(profile, deploymentId || deployment?.id);
      throw deploymentError(
        `Azure deployment timed out after ${Math.round((DEFAULT_TIMEOUT_MS) / 1000)} seconds.\n` +
        `Deployment log:\n${deploymentLog || 'No deployment details were returned by Kudu.'}`,
        { deploymentId: deploymentId || deployment?.id, deploymentLog, logs }
      );
    }
    log('info', '✓ Azure deployment completed successfully');

    log('info', 'Verifying startup configuration…');
    const siteConfig = await azure.getSiteConfig(resourceGroup, name);
    const configuredStartCommand = siteConfig?.properties?.appCommandLine || '';
    if (configuredStartCommand !== startCommand) {
      throw deploymentError(
        `Startup configuration verification failed. Expected "${startCommand}", received "${configuredStartCommand}".`,
        { logs }
      );
    }
    log('info', `✓ Startup command verified: ${configuredStartCommand}`);

    log('info', '✓ Azure build settings configured');

    log('info', 'Verifying deployed files in /home/site/wwwroot…');
    await verifyPackage(profile, log);
    const appCheck = await verifyApplicationRunning(name, log);
    log('info', '✓ Application deployment is live; Azure default placeholder was replaced');

    return {
      success: true,
      deploymentId,
      startCommand,
      packageManager,
      url: appCheck.url,
      httpStatus: appCheck.status,
      logs,
    };
  } catch (err) {
    if (err.logs) {
      err.logs = [...err.logs, ...logs.filter((entry) => !err.logs.includes(entry))];
    } else {
      err.logs = logs;
    }
    throw err;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  deployToAppService,
  parsePublishProfile,
  parseDeploymentStatus,
};