const { decrypt } = require('./crypto.service');

function headers(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Firebox-Deploy' };
}

async function githubRequest(path, token) {
  const response = await fetch(`https://api.github.com${path}`, { headers: headers(token) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `GitHub request failed (${response.status})`);
  return body;
}

function getToken(workspace) {
  const token = workspace && workspace.githubToken ? decrypt(workspace.githubToken) : '';
  if (!token) throw new Error('Connect GitHub before browsing repositories.');
  return token;
}

async function listRepositories(workspace) {
  const token = getToken(workspace);
  const repos = await githubRequest('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token);
  return repos.map((repo) => ({ id: repo.id, name: repo.name, fullName: repo.full_name, private: repo.private, htmlUrl: repo.html_url, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch || 'main', description: repo.description || '', language: repo.language || '', updatedAt: repo.updated_at }));
}

function decodeContent(file) {
  if (!file || !file.content) return null;
  return Buffer.from(file.content, 'base64').toString('utf8');
}

async function inspectRepository(workspace, owner, repo, branch = 'main') {
  const token = getToken(workspace);
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const root = await githubRequest(`/repos/${encodedOwner}/${encodedRepo}/contents?ref=${encodeURIComponent(branch)}`, token);
  const names = new Set((Array.isArray(root) ? root : []).map((item) => item.name));
  let packageJson = null;
  if (names.has('package.json')) {
    packageJson = JSON.parse(decodeContent(await githubRequest(`/repos/${encodedOwner}/${encodedRepo}/contents/package.json?ref=${encodeURIComponent(branch)}`, token)) || '{}');
  }
  const scripts = packageJson?.scripts || {};
  const packageManager = names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : 'npm';
  const framework = packageJson?.dependencies?.next ? 'Next.js' : packageJson?.dependencies?.vite || packageJson?.devDependencies?.vite ? 'Vite' : packageJson?.dependencies?.express ? 'Express' : packageJson?.dependencies?.react ? 'React' : packageJson?.dependencies?.vue ? 'Vue' : packageJson?.dependencies?.['@angular/core'] ? 'Angular' : packageJson ? 'Node.js' : names.has('Dockerfile') ? 'Docker' : 'Unknown';
  return {
    owner, repo, branch, files: [...names].slice(0, 100),
    detected: { packageManager, framework, hasPackageJson: !!packageJson, hasDockerfile: names.has('Dockerfile'), hasCompose: names.has('docker-compose.yml') || names.has('docker-compose.yaml'), hasFireboxConfig: names.has('fireboxdeploy.toml'), buildCommand: scripts.build || '', startCommand: scripts.start || '', scripts: Object.keys(scripts) },
  };
}

module.exports = { listRepositories, inspectRepository };
