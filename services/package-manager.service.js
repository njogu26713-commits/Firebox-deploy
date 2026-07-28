/**
 * Package-manager detection and command construction shared by deployment
 * flows. Lockfile precedence is intentional: pnpm, then Yarn, then npm.
 */

const PACKAGE_MANAGERS = {
  pnpm: {
    install: 'pnpm install',
    build: 'pnpm run build',
    start: 'pnpm start',
    setup: 'command -v corepack >/dev/null 2>&1 || npm install --global corepack; corepack enable; corepack prepare pnpm@latest --activate',
  },
  yarn: {
    install: 'yarn install',
    build: 'yarn build',
    start: 'yarn start',
    setup: '',
  },
  npm: {
    install: 'npm install',
    build: 'npm run build',
    start: 'npm start',
    setup: '',
  },
};

/**
 * Resolve a package manager from lockfile presence.
 * @param {{ pnpm?: boolean, yarn?: boolean, npm?: boolean }} lockfiles
 * @returns {'pnpm'|'yarn'|'npm'}
 */
function detectPackageManager(lockfiles = {}) {
  if (lockfiles.pnpm) return 'pnpm';
  if (lockfiles.yarn) return 'yarn';
  return 'npm';
}

/**
 * Build commands while preserving explicit project overrides.
 * @param {'pnpm'|'yarn'|'npm'} packageManager
 * @param {{ hasBuildScript?: boolean, buildCommand?: string, startCommand?: string }} options
 */
function getPackageManagerCommands(packageManager, options = {}) {
  const manager = PACKAGE_MANAGERS[packageManager] || PACKAGE_MANAGERS.npm;
  const buildCommand = options.buildCommand?.trim()
    || (options.hasBuildScript ? manager.build : '');
  const startCommand = options.startCommand?.trim() || manager.start;

  return {
    packageManager: PACKAGE_MANAGERS[packageManager] ? packageManager : 'npm',
    setupCommand: manager.setup,
    installCommand: manager.install,
    buildCommand,
    startCommand,
  };
}

module.exports = {
  PACKAGE_MANAGERS,
  detectPackageManager,
  getPackageManagerCommands,
};