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

// ── Main pipeline ──────────────────────────────────────────────────────────

/**
 * Run the full SSH deploy pipeline for a project.
 * Called in the background after a Deployment record is created.
 */
async function runDeployPipeline(project, deployment) {
  const logBuffer = [];

  /** Append a log entry to the in-memory buffer and stream it live via Socket.IO. */
  function log(level, message) {
    const entry = { level, message, ts: new Date() };
    logBuffer.push(entry);
    logger.broadcast(deployment, level, message).catch(() => {});
  }

  let conn;

  try {
    // ── Step 1: Connect ──────────────────────────────────────────────────
    const creds = await getSshCredentials(project);
    const deployPath = resolveDeployPath(project, creds);

    log('info', `[1/4] Connecting to ${creds.host}:${creds.port} as ${creds.username}…`);
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
        `git fetch origin`,
        `git checkout ${project.githubBranch || 'main'}`,
        `git pull origin ${project.githubBranch || 'main'}`,
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

      const cloneCmd = `git clone --branch ${project.githubBranch || 'main'} ${project.repoUrl} ${deployPath}`;
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

    // ── Step 3: Install & Build ──────────────────────────────────────────
    log('info', '[3/4] Installing dependencies…');

    // Detect the package manager from the repository's lockfiles. The
    // precedence is pnpm, yarn, then npm; package-lock is therefore not
    // required for the npm fallback.
    const quotedWorkDir = shellQuote(workDir);
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
      `cd ${workDir}`,
      `pm2 describe ${pm2Name} > /dev/null 2>&1`,
      `&& pm2 restart ${pm2Name} --update-env`,
      `|| pm2 start "${startCmd}" --name ${pm2Name} --update-env`,
    ].join(' ');

    const { code: pm2Code } = await sshSvc.exec(
      conn, pm2Cmd,
      (line) => log('info', line),
      (line) => log('warn', line),
    );
    if (pm2Code !== 0) throw new Error('PM2 failed to start/restart the process — check the start command');

    // Save PM2 list so processes survive reboots
    await sshSvc.exec(conn, 'pm2 save --force', (line) => log('info', line));

    // ── Success ───────────────────────────────────────────────────────────
    log('info', '');
    log('info', '✅ Deployment complete!');

    deployment.logs = logBuffer;
    await logger.setStatus(deployment, 'success');

    await Project.findByIdAndUpdate(project._id, {
      status:         'success',
      lastDeployedAt: new Date(),
      deployPath,
      setupError:     '',
    });

  } catch (err) {
    log('error', `❌ Deployment failed: ${err.message}`);

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

module.exports = { triggerDeploy };
