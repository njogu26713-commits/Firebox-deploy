const assert = require('assert');
const {
  detectPackageManager,
  getPackageManagerCommands,
} = require('../services/package-manager.service');

assert.strictEqual(detectPackageManager({ pnpm: true, yarn: true }), 'pnpm');
assert.strictEqual(detectPackageManager({ yarn: true }), 'yarn');
assert.strictEqual(detectPackageManager({ npm: true }), 'npm');
assert.strictEqual(detectPackageManager({}), 'npm');

assert.deepStrictEqual(
  getPackageManagerCommands('pnpm', { hasBuildScript: true }),
  {
    packageManager: 'pnpm',
    setupCommand: 'command -v corepack >/dev/null 2>&1 || npm install --global corepack; corepack enable; corepack prepare pnpm@latest --activate',
    installCommand: 'pnpm install',
    buildCommand: 'pnpm run build',
    startCommand: 'pnpm start',
  },
);

assert.strictEqual(
  getPackageManagerCommands('yarn', { hasBuildScript: false }).buildCommand,
  '',
);
assert.strictEqual(
  getPackageManagerCommands('npm', { hasBuildScript: true }).buildCommand,
  'npm run build',
);
assert.strictEqual(
  getPackageManagerCommands('pnpm', { hasBuildScript: true, startCommand: 'pm2 start ecosystem.config.js' }).startCommand,
  'pm2 start ecosystem.config.js',
);

console.log('package-manager.service tests passed');