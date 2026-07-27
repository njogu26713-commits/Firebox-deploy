/**
 * fireboxdeploy-toml.service.js
 *
 * Parses `fireboxdeploy.toml` — a project-level config file that lets
 * developers pre-configure FireboxDeploy settings (runtime, build/start
 * commands, port, env vars, etc.) alongside their code.
 *
 * Format (TOML-like, hand-parsed to avoid external dependencies):
 *
 *   [app]
 *   name = "my-app"
 *   runtime = "nodejs"          # nodejs | python | php | go | java | dotnet
 *   runtime_version = "20"
 *   build_command = "npm install && npm run build"
 *   start_command = "node server.js"
 *   port = 8080
 *   root_dir = "."
 *
 *   [deploy]
 *   branch = "main"
 *   region = "eastus"
 *   sku = "B1"
 *
 *   [env]
 *   NODE_ENV = "production"
 *   LOG_LEVEL = "info"
 */

const RUNTIME_LINUXFX = {
  nodejs:  (v) => `NODE|${v || '18'}-lts`,
  python:  (v) => `PYTHON|${v || '3.11'}`,
  php:     (v) => `PHP|${v || '8.2'}`,
  go:      (v) => `GO|${v || '1.21'}`,
  java:    (v) => `JAVA|${v || '17'}-java${v || '17'}`,
  dotnet:  (v) => `DOTNETCORE|${v || '8.0'}`,
};

/**
 * Parse a raw fireboxdeploy.toml string into a structured config object.
 * @param {string} content
 * @returns {{ app: object, deploy: object, env: object }}
 */
function parseToml(content) {
  const result = { app: {}, deploy: {}, env: {} };
  let currentSection = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Section header [section]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }

    // Key = value
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      let key = kvMatch[1];
      let rawVal = kvMatch[2].trim();

      // Strip inline comments
      rawVal = rawVal.replace(/\s+#.*$/, '');

      // Unquote strings
      let value;
      if ((rawVal.startsWith('"') && rawVal.endsWith('"')) ||
          (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
        value = rawVal.slice(1, -1);
      } else if (rawVal === 'true') {
        value = true;
      } else if (rawVal === 'false') {
        value = false;
      } else if (!isNaN(rawVal) && rawVal !== '') {
        value = Number(rawVal);
      } else {
        value = rawVal;
      }

      result[currentSection][key] = value;
    }
  }

  return result;
}

/**
 * Convert a parsed fireboxdeploy.toml config into a FireboxDeploy deploy payload.
 * @param {object} config  Output of parseToml()
 * @returns {object} Partial deploy payload ready to merge into the deploy request
 */
function configToDeployPayload(config) {
  const { app = {}, deploy = {}, env = {} } = config;

  const runtime        = (app.runtime || 'nodejs').toLowerCase();
  const runtimeVersion = String(app.runtime_version || '');
  const linuxFxVersion = RUNTIME_LINUXFX[runtime]
    ? RUNTIME_LINUXFX[runtime](runtimeVersion)
    : RUNTIME_LINUXFX.nodejs(runtimeVersion);

  // Convert [env] section to array for AzureApp model
  const envVars = Object.entries(env).map(([key, value]) => ({
    key,
    value: String(value),
    secret: false,
  }));

  return {
    name:           app.name           || '',
    runtime,
    runtimeVersion,
    runtimeStack:   linuxFxVersion,
    buildCommand:   app.build_command  || '',
    startCommand:   app.start_command  || '',
    port:           Number(app.port)   || 8080,
    rootDir:        app.root_dir       || '.',
    branch:         deploy.branch      || 'main',
    region:         deploy.region      || 'eastus',
    planSku:        deploy.sku         || 'B1',
    envVars,
  };
}

/**
 * Attempt to fetch and parse fireboxdeploy.toml from a GitHub repo's raw content.
 * Returns null (silently) if the file doesn't exist or the URL isn't a valid GitHub repo.
 *
 * @param {string} repoUrl  e.g. https://github.com/owner/repo
 * @param {string} branch
 * @returns {Promise<object|null>}
 */
async function fetchFromGitHub(repoUrl, branch = 'main') {
  try {
    // Normalise URL
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
    if (!match) return null;
    const [, owner, repo] = match;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/fireboxdeploy.toml`;

    const res = await fetch(rawUrl, { headers: { 'User-Agent': 'FireboxDeploy/1.0' } });
    if (!res.ok) return null;

    const text = await res.text();
    const config = parseToml(text);
    return configToDeployPayload(config);
  } catch {
    return null;
  }
}

module.exports = { parseToml, configToDeployPayload, fetchFromGitHub };
