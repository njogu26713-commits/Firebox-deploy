/**
 * deploy.service.js
 * SSH-based deployment pipeline:
 *   1. Connect to VPS via SSH
 *   2. Clone repository (first run) or git pull (subsequent)
 *   3. Detect package manager and install dependencies
 *   4. Build (if buildCommand set)
 *   5. Write .env file from stored env vars
 *   6. PM2 start (first run) or pm2 restart (subsequent)
 */

const Project    = require('../models/Project');
const Deployment = require('../models/Deployment');
const User       = require('../models/User');
const logger     = require('./logger.service');
const cryptoSvc  = require('./crypto.service');
const sshSvc     = require('./ssh.service');
const azureAgent  = require('./azureAgent.service');
const { downloadRepositoryFiles } = require('./user-github.service');
const {
  detectPackageManager,
  getPackageManagerCommands,
} = require('./package-manager.service');

const DEFAULT_DEPLOY_ROOT = '/opt/apps';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Retrieve and decrypt SSH credentials for the project owner, or throw. */
async function getSshCredentials(project) {
  const user = await User.findById(project.owner);
  if (!user || !user.sshHost || !user.sshUsername) {
    throw new Error(
      'No SSH credentials configured. Go to Settings and add your VPS connection details first.'
    );
  }
  if (!user.sshPrivateKey && !user.sshPassword) {
    throw new Error(
      'No SSH authentication configured. Add a private key or password in Settings.'
    );
  }

  return {
    host:        user.sshHost,
    port:        user.sshPort || 22,
    username:    user.sshUsername,
    privateKey:  user.sshPrivateKey ? cryptoSvc.decrypt(user.sshPrivateKey) : undefined,
    password:    user.sshPassword   ? cryptoSvc.decrypt(user.sshPassword)   : undefined,
    deployRoot:  user.sshDeployRoot || DEFAULT_DEPLOY_ROOT,
  };
}

/** Determine the full deploy path for a project on the VPS. */
function resolveDeployPath(project, creds) {
  return project.deployPath && project.deployPath.trim()
    ? project.deployPath.trim()
    : `${creds.deployRoot}/${project.slug}`;
}

/** Quote a path for the remote POSIX shell. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runtimeEnvVars(project) {
  return (project.envVars || []).map((item) => ({ ...item, value: item.encrypted && String(item.value || '').includes(':') ? cryptoSvc.decrypt(item.value) : String(item.value || '') })).filter((item) => item.key && item.value !== '');
}

function projectPort(project) {
  const envPort = runtimeEnvVars(project).find((item) => item.key === 'PORT')?.value;
  const port = Number(project.vpsPort || envPort || 3000);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3000;
}

function safeHealthPath(path) {
  const value = String(path || '/').trim();
  return value.startsWith('/') && !/[\n\r\s]/.test(value) ? value : '/';
}

function agentRepositoryRef(project) {
  const fullName = String(project.githubRepoFullName || '').trim();
  if (/^[^/]+\/[^/]+$/.test(fullName)) return fullName.split('/');
  const match = String(project.repoUrl || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error('A GitHub repository reference is required for Azure Agent deployment.');
  return [match[1], match[2]];
}

function configuredTransportMode() {
  const mode = String(process.env.FIREBOX_DEPLOY_TRANSPORT || 'auto').trim().toLowerCase();
  return ['auto', 'azure-agent', 'ssh'].includes(mode) ? mode : 'auto';
}

async function shouldUseAzureAgent(project) {
  const mode = configuredTransportMode();
  if (mode === 'ssh') return false;
  if (mode === 'azure-agent' && !azureAgent.getConfigStatus().configured) throw new Error('FIREBOX_DEPLOY_TRANSPORT=azure-agent requires FIREBOX_AZURE_AGENT_URL and FIREBOX_AZURE_AGENT_SECRET.');
  if (!azureAgent.getConfigStatus().configured) return false;
  if (project.deploymentTarget === 'azure-agent') return true;
  if (project.type === 'docker') return true;
  if (!project.githubToken) return false;
  try {
    const [owner, repo] = agentRepositoryRef(project);
    const inspection = await require('./user-github.service').inspectRepository({ githubToken: project.githubToken }, owner, repo, project.githubBranch || 'main');
    return inspection.detected?.hasDockerfile === true;
  } catch {
    return false;
  }
}

function generatedNodeDockerfile(project, port) {
  const packageManager = ['npm', 'pnpm', 'yarn'].includes(project.packageManager) ? project.packageManager : 'npm';
  const installAndBuild = packageManager === 'pnpm'
    ? 'corepack enable && pnpm install --frozen-lockfile && pnpm run build --if-present'
    : packageManager === 'yarn'
      ? 'corepack enable && yarn install --frozen-lockfile && yarn run build --if-present'
      : 'if [ -f package-lock.json ]; then npm ci; else npm install; fi && npm run build --if-present';
  return `FROM node:20-bookworm-slim\nWORKDIR /app\nCOPY . .\nRUN ${installAndBuild}\nENV NODE_ENV=production PORT=${port}\nEXPOSE ${port}\nCMD ["npm", "run", "start"]\n`;
}

async function runAzureAgentPipeline(project, deployment, log) {
  project = { ...project, envVars: runtimeEnvVars(project) };
  const token = project.githubToken ? cryptoSvc.decrypt(project.githubToken) : '';
  if (!token) throw new Error('The project has no encrypted GitHub token available for Azure Agent deployment.');
  const [owner, repo] = agentRepositoryRef(project);
  const branch = project.githubBranch || 'main';
  const files = await downloadRepositoryFiles(token, owner, repo, branch);
  log('info', `[2/4] Transferring ${files.length} repository files to the Azure Agent…`);
  await azureAgent.createProject(project.slug);
  for (const file of files) await azureAgent.writeFile(project.slug, file.path, file.content);
  if (project.envVars && project.envVars.length) {
    const envContent = project.envVars.filter((item) => item.key).map((item) => `${item.key}=${item.value}`).join('\\n') + '\\n';
    await azureAgent.writeFile(project.slug, '.env', envContent);
    log('info', `✓ Environment file transferred (${project.envVars.length} variables)`);
  }
  const port = projectPort(project);
  const isDockerProject = project.type === 'docker' || files.some((file) => file.path === 'Dockerfile');
  if (!isDockerProject) {
    log('info', '[3/4] Preparing a generated Dockerfile for the Node project on the Azure Agent…');
    await azureAgent.writeFile(project.slug, 'Dockerfile', generatedNodeDockerfile(project, port));
  }
  log('info', '[3/4] Starting controlled Docker deployment on the Azure Agent…');
  const started = await azureAgent.deploy(project.slug, { runtime: 'docker', port });
  log('info', `✓ Azure Agent job ${started.jobId} queued`);
  let seenLogs = 0;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await azureAgent.jobStatus(started.jobId);
    const job = result.job || result;
    const logs = Array.isArray(job.logs) ? job.logs : [];
    for (const entry of logs.slice(seenLogs)) log(entry.level || 'info', entry.message || '');
    seenLogs = logs.length;
    if (job.status === 'succeeded') {
      log('info', '[4/4] Azure Agent reports the container is running.');
      deployment.meta = { ...(deployment.meta || {}), server: 'firebox-azure-agent', runtime: 'docker', agentJobId: started.jobId, port: projectPort(project) };
      return started.jobId;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Azure Agent deployment failed.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Azure Agent deployment timed out while waiting for the job to complete.');
}

async function configureReverseProxy(conn, project, deployPath, port, log) {
  const rawDomain = String(project.customDomain || project.vpsUrl || '').trim();
  if (!rawDomain) return '';
  const domain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error('Configured deployment domain contains invalid characters.');
  const sitePath = `/etc/caddy/sites-enabled/${project.slug}.caddy`;
  await sshSvc.exec(conn, 'mkdir -p /etc/caddy/sites-enabled');
  const siteConfig = `${domain} {\n  reverse_proxy 127.0.0.1:${port}\n}\n`;
  const result = await sshSvc.writeFile(conn, sitePath, siteConfig).then(() => ({ code: 0 })).catch((err) => ({ code: 1, error: err }));
  if (result.code !== 0) throw new Error(`Reverse proxy configuration was not written: ${result.error.message}`);
  const validation = await sshSvc.exec(conn, 'caddy validate --config /etc/caddy/Caddyfile');
  if (validation.code !== 0) throw new Error(`Caddy configuration validation failed: ${validation.stderr || validation.stdout}`);
  const reload = await sshSvc.exec(conn, 'systemctl reload caddy');
  if (reload.code !== 0) throw new Error('Caddy reload failed after deployment.');
  log('info', `✓ Reverse proxy configured for ${domain}`);
  return /^https?:\/\//i.test(rawDomain) ? rawDomain : `https://${domain}`;
}

async function healthCheck(conn, port, healthPath, log) {
  log('info', `Checking application health at http://127.0.0.1:${port}${healthPath}…`);
  const result = await sshSvc.exec(conn, `curl -fsS --max-time 10 http://127.0.0.1:${port}${healthPath}`);
  if (result.code !== 0) throw new Error(`Application health check failed on port ${port}${healthPath}`);
  log('info', '✓ Application is healthy');
}

async function runDockerPipeline(conn, project, workDir, log) {
  project = { ...project, envVars: runtimeEnvVars(project) };
  const port = projectPort(project);
  const healthPath = safeHealthPath(project.healthPath);
  const quotedPath = shellQuote(workDir);
  if (project.envVars && project.envVars.length > 0) {
    const envContent = project.envVars.filter((item) => item.key).map((item) => `${item.key}=${item.value}`).join('\n') + '\n';
    await sshSvc.writeFile(conn, `${workDir}/.env`, envContent);
    log('info', `✓ .env written (${project.envVars.length} variable${project.envVars.length === 1 ? '' : 's'})`);
  }
  const composeCheck = await sshSvc.exec(conn, `test -f ${quotedPath}/docker-compose.yml || test -f ${quotedPath}/docker-compose.yaml`);
  if (composeCheck.code === 0) {
    log('info', 'Building Docker Compose services…');
    const compose = await sshSvc.exec(conn, `cd ${quotedPath} && docker compose -p ${shellQuote(`firebox-${project.slug}`)} up -d --build`, (line) => log('info', line), (line) => log('warn', line));
    if (compose.code !== 0) throw new Error('Docker Compose build/start failed');
  } else {
    const image = `firebox-${project.slug}:latest`;
    log('info', `Building Docker image ${image}…`);
    const build = await sshSvc.exec(conn, `docker build -t ${shellQuote(image)} ${quotedPath}`, (line) => log('info', line), (line) => log('warn', line));
    if (build.code !== 0) throw new Error('Docker image build failed');
    await sshSvc.exec(conn, `docker rm -f ${shellQuote(project.slug)} >/dev/null 2>&1 || true`);
    const envArg = project.envVars && project.envVars.length ? `--env-file ${shellQuote(`${workDir}/.env`)}` : '';
    const start = await sshSvc.exec(conn, `docker run -d --restart unless-stopped --name ${shellQuote(project.slug)} ${envArg} -p 127.0.0.1:${port}:${port} ${shellQuote(image)}`);
    if (start.code !== 0) throw new Error('Docker container failed to start');
  }
  log('info', '✓ Container running');
  await healthCheck(conn, port, healthPath, log);
  const url = await configureReverseProxy(conn, project, workDir, port, log);
  return { port, url };
}

// ── Main pipeline ──────────────────────────────────────────────────────────

/**
 * Run the full SSH deploy pipeline for a project.
 * Called in the background after a Deployment record is created.
 */
async function runDeployPipeline(project, deployment) {
  project = { ...project, envVars: runtimeEnvVars(project) };
  const logBuffer = [];
  const pendingLogWrites = [];

  /** Append a log entry to the in-memory buffer and stream it live via Socket.IO. */
  function log(level, message) {
    const entry = { level, message, ts: new Date() };
    logBuffer.push(entry);
    pendingLogWrites.push(logger.broadcast(deployment, level, message).catch(() => {}));
  }

  let conn;

  try {
    // ── Step 1: Select the Azure Agent or legacy SSH transport ───────────
    // Docker projects use the authenticated HTTPS agent when configured. The
    // existing SSH path remains available for non-Docker projects so current
    // deployments are preserved while the migration is staged safely.
    const deploymentTarget = project.deploymentTarget || (configuredTransportMode() === 'ssh' ? 'ssh' : 'azure-agent');
    const useAzureAgent = deploymentTarget === 'azure-agent' ? await shouldUseAzureAgent(project) : false;
    if (deploymentTarget === 'azure-agent' && !useAzureAgent) throw new Error('Azure Agent target is selected, but the Agent is not configured. Direct SSH fallback is disabled.');
    if (useAzureAgent) {
      log('info', 'Using authenticated Azure Agent transport; direct Railway-to-VM SSH is not used.');
      await logger.setStatus(deployment, 'building');
      deployment.status = 'building';
      await runAzureAgentPipeline(project, deployment, log);
      deployment.url = project.vpsUrl || '';
      log('info', 'DEPLOYMENT SUCCESSFUL');
      await Promise.all(pendingLogWrites);
      deployment.logs = logBuffer;
      await logger.setStatus(deployment, 'success');
      await Project.findByIdAndUpdate(project._id, { status: 'success', lastDeployedAt: new Date(), vpsUrl: project.vpsUrl || '', setupError: '' });
      return;
    }

    if (deploymentTarget === 'azure-agent') throw new Error('Azure Agent target is selected, but direct SSH fallback is disabled.');
    if (azureAgent.getConfigStatus().configured) log('info', `SSH target selected explicitly for stored runtime ${project.type || 'unknown'}; using legacy SSH transport.`);
    const creds = await getSshCredentials(project);
    const deployPath = resolveDeployPath(project, creds);
    const githubToken = project.githubToken ? cryptoSvc.decrypt(project.githubToken) : '';
    const gitCommand = githubToken ? `git -c http.extraheader=${shellQuote(`AUTHORIZATION: bearer ${githubToken}`)}` : 'git';

    log('info', `[1/4] Checking TCP reachability to ${creds.host}:${creds.port}…`);
    const tcp = await sshSvc.probeTcp({ host: creds.host, port: creds.port, timeout: 10000 });
    if (!tcp.ok) {
      throw new Error(`VPS network unreachable at ${creds.host}:${creds.port}: ${tcp.error}. Railway can resolve the configured destination but cannot establish TCP; check Railway outbound networking, its egress allowlist, or use a reachable deployment transport.`);
    }
    log('info', `✓ TCP connection established in ${tcp.elapsedMs}ms`);
    log('info', `Connecting to ${creds.host}:${creds.port} as ${creds.username}…`);
    conn = await sshSvc.connect({
      host:       creds.host,
      port:       creds.port,
      username:   creds.username,
      privateKey: creds.privateKey,
      password:   creds.password,
    });
    log('info', '✓ SSH connection established');

    // ── Step 2: Clone or Pull ────────────────────────────────────────────
    await logger.setStatus(deployment, 'building');
    deployment.status = 'building';

    const { code: existsCode } = await sshSvc.exec(conn, `test -d ${deployPath}/.git`);

    if (existsCode === 0) {
      // Directory already cloned — pull latest
      log('info', `[2/4] Repository found at ${deployPath} — running git pull…`);
      const pullCmd = [
        `cd ${deployPath}`,
        `${gitCommand} fetch origin`,
        `${gitCommand} checkout ${project.githubBranch || 'main'}`,
        `${gitCommand} pull origin ${project.githubBranch || 'main'}`,
      ].join(' && ');

      const { code: pullCode } = await sshSvc.exec(
        conn, pullCmd,
        (line) => log('info', line),
        (line) => log('warn', line),
      );
      if (pullCode !== 0) throw new Error('git pull failed — check the repository URL and branch name');
    } else {
      // First deployment — clone
      log('info', `[2/4] Cloning ${project.repoUrl} (branch: ${project.githubBranch || 'main'})…`);

      // Ensure parent directory exists
      const parentDir = deployPath.substring(0, deployPath.lastIndexOf('/'));
      await sshSvc.exec(conn, `mkdir -p ${parentDir}`);

      const cloneCmd = `${gitCommand} clone --branch ${project.githubBranch || 'main'} ${project.repoUrl} ${deployPath}`;
      const { code: cloneCode } = await sshSvc.exec(
        conn, cloneCmd,
        (line) => log('info', line),
        (line) => log('warn', line),
      );
      if (cloneCode !== 0) throw new Error('git clone failed — verify the repo URL is accessible from your VPS');

      // Persist the resolved deploy path so subsequent deploys use it
      await Project.findByIdAndUpdate(project._id, { deployPath });
    }

    // Work directory (repo root or configured sub-directory)
    const rootSuffix = project.rootDirectory && project.rootDirectory !== '.' ? `/${project.rootDirectory}` : '';
    const workDir    = `${deployPath}${rootSuffix}`;
    const quotedWorkDir = shellQuote(workDir);
    const port = projectPort(project);
    const healthPath = safeHealthPath(project.healthPath);
    const dockerfile = await sshSvc.exec(conn, `test -f ${quotedWorkDir}/Dockerfile`);
    const compose = await sshSvc.exec(conn, `test -f ${quotedWorkDir}/docker-compose.yml || test -f ${quotedWorkDir}/docker-compose.yaml`);

    if (dockerfile.code === 0 || compose.code === 0 || project.type === 'docker') {
      log('info', '[3/4] Docker project detected.');
      const dockerResult = await runDockerPipeline(conn, project, workDir, log);
      await logger.setStatus(deployment, 'deploying');
      deployment.status = 'deploying';
      deployment.url = dockerResult.url;
      deployment.meta = { ...(deployment.meta || {}), server: 'firebox-server', port: dockerResult.port, runtime: 'docker' };
      log('info', 'DEPLOYMENT SUCCESSFUL');
      await Promise.all(pendingLogWrites);
      deployment.logs = logBuffer;
      await logger.setStatus(deployment, 'success');
      await Project.findByIdAndUpdate(project._id, { status: 'success', lastDeployedAt: new Date(), deployPath, vpsPort: dockerResult.port, vpsUrl: dockerResult.url || project.vpsUrl || '', setupError: '' });
      return;
    }

    // ── Step 3: Install & Build ──────────────────────────────────────────
    log('info', '[3/4] Installing dependencies…');

    // Detect the package manager from the repository's lockfiles. The
    // precedence is pnpm, yarn, then npm; package-lock is therefore not
    // required for the npm fallback.
    const lockfileResult = await sshSvc.exec(
      conn,
      `if [ -f ${quotedWorkDir}/pnpm-lock.yaml ]; then printf pnpm; ` +
      `elif [ -f ${quotedWorkDir}/yarn.lock ]; then printf yarn; ` +
      `elif [ -f ${quotedWorkDir}/package-lock.json ]; then printf npm; ` +
      `else printf npm; fi`,
    );
    const packageManager = detectPackageManager({
      pnpm: lockfileResult.stdout.trim() === 'pnpm',
      yarn: lockfileResult.stdout.trim() === 'yarn',
      npm: lockfileResult.stdout.trim() === 'npm',
    });

    const buildScriptResult = await sshSvc.exec(
      conn,
      `cd ${quotedWorkDir} && node -e ` +
      `'const p=require("./package.json"); process.stdout.write(p.scripts && p.scripts.build ? "yes" : "no")'`,
    );
    const commands = getPackageManagerCommands(packageManager, {
      hasBuildScript: buildScriptResult.code === 0 && buildScriptResult.stdout.trim() === 'yes',
      buildCommand: project.buildCommand,
      startCommand: project.startCommand,
    });

    log('info', `✓ Detected ${commands.packageManager} package manager`);

    if (commands.setupCommand) {
      log('info', 'Enabling Corepack for pnpm…');
      const { code: corepackCode } = await sshSvc.exec(
        conn,
        commands.setupCommand,
        (line) => log('info', line),
        (line) => log('warn', line),
      );
      if (corepackCode !== 0) throw new Error('Could not enable Corepack for pnpm');

      // ── Resolve and verify pnpm binary ──────────────────────────────────
      // PATH may not be refreshed inside the current SSH session after
      // `corepack enable`, so we resolve the absolute path explicitly before
      // spawning pnpm.
      log('info', 'Verifying pnpm executable path…');
      let resolvedPnpm = '';

      const { stdout: whichOut, code: whichCode } = await sshSvc.exec(
        conn,
        'which pnpm 2>/dev/null || command -v pnpm 2>/dev/null',
      );
      if (whichCode === 0 && whichOut.trim()) {
        resolvedPnpm = whichOut.trim();
      } else {
        // Fallback: look in npm's global bin directory
        const { stdout: npmBinOut } = await sshSvc.exec(conn, 'npm bin -g 2>/dev/null');
        const candidate = `${npmBinOut.trim()}/pnpm`;
        const { code: testCode } = await sshSvc.exec(conn, `test -x ${candidate}`);
        if (testCode === 0) resolvedPnpm = candidate;
      }

      if (!resolvedPnpm) {
        throw new Error(
          'pnpm executable not found after Corepack setup — ' +
          'ensure Node.js ≥16.9 is installed and Corepack is available on the remote host.',
        );
      }

      const { stdout: verOut, code: verCode } = await sshSvc.exec(
        conn, `${resolvedPnpm} --version`,
      );
      if (verCode !== 0) {
        throw new Error(
          `pnpm found at ${resolvedPnpm} but failed to execute — ` +
          'ensure the binary is not corrupted and has executable permissions.',
        );
      }
      log('info', `✓ pnpm executable: ${resolvedPnpm} (v${verOut.trim()})`);

      // Patch all downstream commands to use the absolute path so they are
      // immune to PATH differences across SSH exec channels.
      commands.installCommand = commands.installCommand.replace(/^pnpm\b/, resolvedPnpm);
      commands.buildCommand   = commands.buildCommand.replace(/^pnpm\b/, resolvedPnpm);
      commands.startCommand   = commands.startCommand.replace(/^pnpm\b/, resolvedPnpm);
    }

    const { code: installCode } = await sshSvc.exec(
      conn, `cd ${quotedWorkDir} && ${commands.installCommand}`,
      (line) => log('info', line),
      (line) => log('warn', line),
    );
    if (installCode !== 0) throw new Error('Dependency installation failed');

    if (commands.buildCommand) {
      log('info', `[3/4] Building: ${commands.buildCommand}`);
      const { code: buildCode } = await sshSvc.exec(
        conn, `cd ${quotedWorkDir} && ${commands.buildCommand}`,
        (line) => log('info', line),
        (line) => log('warn', line),
      );
      if (buildCode !== 0) throw new Error(`Build command failed: ${commands.buildCommand}`);
    }

    // Write .env file if env vars are configured
    if (project.envVars && project.envVars.length > 0) {
      const envContent = project.envVars
        .filter((e) => e.key)
        .map((e) => `${e.key}=${e.value}`)
        .join('\n') + '\n';

      await sshSvc.writeFile(conn, `${workDir}/.env`, envContent).catch((err) => {
        log('warn', `Could not write .env file (non-fatal): ${err.message}`);
      });
      log('info', `✓ .env written (${project.envVars.length} variable${project.envVars.length !== 1 ? 's' : ''})`);
    }

    // ── Step 4: PM2 Start or Restart ─────────────────────────────────────
    await logger.setStatus(deployment, 'deploying');
    deployment.status = 'deploying';

    const pm2Name    = project.pm2Name || project.slug;
    const startCmd   = commands.startCommand;

    log('info', `[4/4] Starting with PM2 (process: ${pm2Name})…`);

    // Atomically check and start/restart — avoids race conditions
    const pm2Cmd = [
      `cd ${quotedWorkDir}`,
      `PORT=${port} pm2 describe ${shellQuote(pm2Name)} > /dev/null 2>&1`,
      `&& PORT=${port} pm2 restart ${shellQuote(pm2Name)} --update-env`,
      `|| PORT=${port} pm2 start ${shellQuote(startCmd)} --name ${shellQuote(pm2Name)} --update-env`,
    ].join(' ');

    const { code: pm2Code } = await sshSvc.exec(
      conn, pm2Cmd,
      (line) => log('info', line),
      (line) => log('warn', line),
    );
    if (pm2Code !== 0) throw new Error('PM2 failed to start/restart the process — check the start command');

    // Save PM2 list so processes survive reboots
    await sshSvc.exec(conn, 'pm2 save --force', (line) => log('info', line));
    await healthCheck(conn, port, healthPath, log);
    const publicUrl = await configureReverseProxy(conn, project, deployPath, port, log);

    // ── Success ───────────────────────────────────────────────────────────
    log('info', 'DEPLOYMENT SUCCESSFUL');
    deployment.url = publicUrl || project.vpsUrl || '';
    deployment.meta = { ...(deployment.meta || {}), server: 'firebox-server', port, runtime: 'node' };
    await Promise.all(pendingLogWrites);
    deployment.logs = logBuffer;
    await logger.setStatus(deployment, 'success');

    await Project.findByIdAndUpdate(project._id, {
      status:         'success',
      lastDeployedAt: new Date(),
      deployPath,
      vpsPort:        port,
      vpsUrl:         publicUrl || project.vpsUrl || '',
      setupError:     '',
    });

  } catch (err) {
    const detail = String(err.message || err);
    const connectionHint = /handshake|timed out|timeout/i.test(detail) ? ' Check VPS reachability, the SSH port, and the VPS firewall/provider allowlist.' : /authentication|auth|key|password/i.test(detail) ? ' Check the configured SSH username and private key or password.' : '';
    log('error', `❌ Deployment failed: ${detail}${connectionHint}`);

    await Promise.all(pendingLogWrites);
    deployment.logs = logBuffer;
    await logger.setStatus(deployment, 'failed').catch(() => {});

    await Project.findByIdAndUpdate(project._id, {
      status:     'failed',
      setupError: err.message,
    }).catch(() => {});

  } finally {
    if (conn) conn.end();

    const updatedProject = await Project.findById(project._id).catch(() => project);
    await logger.broadcastProjectStatus(updatedProject).catch(() => {});
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Trigger a new deployment for the given project.
 * Creates a Deployment record, responds immediately, then runs the pipeline.
 */
async function resumePendingDeployments() {
  const pending = await Deployment.find({ status: { $in: ['queued', 'building', 'deploying'] } }).populate('project');
  for (const deployment of pending) {
    if (!deployment.project) {
      await Deployment.findByIdAndUpdate(deployment._id, { status: 'failed', completedAt: new Date(), $push: { logs: { level: 'error', message: 'Deployment project no longer exists.', ts: new Date() } } });
      continue;
    }
    runDeployPipeline(deployment.project, deployment).catch((err) => console.error(`[deploy] resume error for ${deployment.project.slug}:`, err.message));
  }
  return pending.length;
}

async function triggerDeploy(project, triggeredBy = 'manual') {
  const deployment = await Deployment.create({
    project:     project._id,
    status:      'queued',
    triggeredBy,
    logs:        [],
  });

  // Update project status immediately so the UI reflects it
  await Project.findByIdAndUpdate(project._id, { status: 'building', setupError: '' });
  await logger.broadcastProjectStatus({ ...project.toObject?.() || project, _id: project._id, status: 'building' });

  // Run in background — progress streams via Socket.IO
  runDeployPipeline(project, deployment).catch((err) =>
    console.error(`[deploy] pipeline error for ${project.slug}:`, err.message)
  );

  return { deployment, deploymentId: deployment._id };
}

module.exports = { triggerDeploy, resumePendingDeployments };
