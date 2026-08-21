function escapeHtml(value) { const el = document.createElement('textarea'); el.textContent = value == null ? '' : String(value); return el.innerHTML; }

let activeUserDeploymentId = '';
let activeUserProjectId = '';
let hydratedUserDeploymentId = '';

const userSections = {
  home: ['Your workspace', 'One place to plan and ship your projects.'],
  projects: ['Projects', 'Your connected applications.'],
  source: ['Source Control', 'Connect a repository to your workspace.'],
  history: ['History', 'Recent deployment activity.'],
  deploy: ['Deploy', 'Choose where to deploy your project.'],
  settings: ['Settings', 'Manage your workspace preferences.'],
};

async function userFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `User request failed (${response.status})`);
  return data;
}

function showUserSection(name, updateHash = true) {
  if (!userSections[name]) name = 'home';
  document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
  document.querySelectorAll('#userNav [data-section]').forEach((item) => item.classList.toggle('active', item.dataset.section === name));
  document.getElementById('sectionTitle').textContent = userSections[name][0];
  document.getElementById('sectionSubtitle').textContent = userSections[name][1];
  if (updateHash) history.replaceState(null, '', `#${name}`);
  if (name === 'projects') loadUserProjects();
  if (name === 'history') loadUserHistory();
}

document.querySelectorAll('#userNav [data-section]').forEach((item) => item.addEventListener('click', () => showUserSection(item.dataset.section)));
document.querySelectorAll('[data-go]').forEach((item) => item.addEventListener('click', () => showUserSection(item.dataset.go)));

function setIdentity() {
  const name = localStorage.getItem('firebox_user_name') || 'Workspace user';
  const email = localStorage.getItem('firebox_user_email') || 'user workspace';
  ['userName', 'settingsUserName'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = name; });
  ['userEmail', 'settingsUserEmail'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = email; });
}

function userProjectCard(project) {
  const deployable = project.sourceType !== 'upload';
  const currentStatus = project.lastDeploymentId ? 'Deploy again' : 'Deploy this project';
  return `<div class="card project-card"><div class="project-card-head"><div><div class="project-name">${escapeHtml(project.name)}</div><div class="project-type">${escapeHtml(project.framework || 'User workspace project')}</div></div><div class="beacon"><span class="beacon-dot"></span>${escapeHtml(project.lastDeploymentId ? 'deployment available' : 'connected')}</div></div><div class="project-domain">${escapeHtml(project.repoUrl)}</div><div class="project-meta"><span>Branch <b>${escapeHtml(project.branch || 'main')}</b></span><span>Provider <b>Firebox VPS</b></span></div><div class="project-card-actions">${deployable ? `<button class="btn btn-primary btn-sm user-deploy-project" data-project-id="${project._id}">${currentStatus} →</button>` : '<span class="text-muted project-upload-note">Connect GitHub to deploy</span>'}</div></div>`;
}

function showUserDeploymentConsole(project, deploymentId, status = 'queued') {
  activeUserDeploymentId = String(deploymentId || '');
  activeUserProjectId = String(project?._id || '');
  const consoleEl = document.getElementById('userDeploymentConsole');
  consoleEl.style.display = 'block';
  document.getElementById('userDeploymentTitle').textContent = `Deployment #${deploymentId} · ${project?.name || 'Project'}`;
  document.getElementById('userDeploymentStatus').textContent = status;
  document.getElementById('userDeploymentSummary').innerHTML = `Repository: <strong>${escapeHtml(project?.repoUrl || '—')}</strong><br>Branch: <strong>${escapeHtml(project?.branch || 'main')}</strong><br>Server: <strong>firebox-server</strong>`;
  if (hydratedUserDeploymentId !== activeUserDeploymentId) {
    document.getElementById('userDeploymentTerminal').textContent = '';
    document.getElementById('userDeploymentResult').style.display = 'none';
    document.querySelectorAll('#userDeploymentSteps [data-stage]').forEach((item) => item.dataset.state = '');
    hydratedUserDeploymentId = activeUserDeploymentId;
  }
  showUserSection('deploy');
}

function appendUserDeploymentLog(entry) {
  const terminal = document.getElementById('userDeploymentTerminal');
  const line = document.createElement('div');
  line.className = `deployment-log-line ${entry.level || 'info'}`;
  line.textContent = `[${new Date(entry.ts || Date.now()).toLocaleTimeString()}] ${entry.message || ''}`;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function updateUserDeploymentStatus(status, deployment = {}) {
  document.getElementById('userDeploymentStatus').textContent = status;
  const stateMap = { queued: 'queue', building: 'build', deploying: 'start', success: 'health', failed: 'health' };
  const current = stateMap[status];
  const order = ['validate', 'queue', 'ssh', 'source', 'build', 'start', 'health'];
  const currentIndex = current ? order.indexOf(current) : -1;
  document.querySelectorAll('#userDeploymentSteps [data-stage]').forEach((item) => {
    const index = order.indexOf(item.dataset.stage);
    item.dataset.state = index < currentIndex ? 'done' : index === currentIndex ? 'running' : '';
  });
  if (['success', 'failed', 'crashed'].includes(status)) {
    const result = document.getElementById('userDeploymentResult');
    result.style.display = 'block';
    result.innerHTML = status === 'success' ? `<strong>DEPLOYMENT SUCCESSFUL</strong><br>Project is running.${deployment.url ? `<br>URL: <a href="${escapeHtml(deployment.url)}" target="_blank">${escapeHtml(deployment.url)}</a>` : ''}` : `<strong>DEPLOYMENT FAILED</strong><br>${escapeHtml((deployment.logs || []).slice(-1)[0]?.message || 'Review the deployment logs.')}`;
  }
}

async function deployUserProject(projectId, button) {
  button.disabled = true; button.textContent = 'Creating deployment…';
  try {
    const result = await userFetch(`/api/user/workspace/projects/${projectId}/deploy`, { method: 'POST' });
    const project = (window.fireboxUserProjects || []).find((item) => String(item._id) === String(projectId)) || { _id: projectId };
    showUserDeploymentConsole(project, result.deploymentId, result.status || 'queued');
    fireboxSocket.emit('subscribe:deployment', String(result.deploymentId));
    appendUserDeploymentLog({ level: 'info', message: `Deployment ${result.deploymentId} queued. The VPS pipeline is starting.`, ts: new Date() });
    updateUserDeploymentStatus('queued');
    button.textContent = 'Deployment queued';
    await loadWorkspace();
  } catch (err) { showToast(err.message, 'error'); button.disabled = false; button.textContent = 'Deploy this project →'; }
}

function bindDeployButtons(container) {
  container.addEventListener('click', (event) => {
    const button = event.target.closest('.user-deploy-project');
    if (button) deployUserProject(button.dataset.projectId, button);
  });
}
bindDeployButtons(document.getElementById('userProjectsGrid'));
bindDeployButtons(document.getElementById('userDeployGrid'));

async function loadWorkspace() {
  try {
    const { workspace } = await userFetch('/api/user/workspace');
    const projects = workspace.projects || [];
    window.fireboxUserProjects = projects;
    document.getElementById('homeProjectCount').textContent = projects.length;
    document.getElementById('userProjectsGrid').innerHTML = projects.map(userProjectCard).join('');
    document.getElementById('userDeployGrid').innerHTML = projects.filter((project) => project.sourceType !== 'upload').map(userProjectCard).join('');
    document.getElementById('userProjectsEmpty').style.display = projects.length ? 'none' : 'block';
    document.getElementById('userDeployEmpty').style.display = projects.some((project) => project.sourceType !== 'upload') ? 'none' : 'block';
    renderUserHistory(workspace.activity || []);
    pollActiveDeployments(projects);
  } catch (err) {
    document.getElementById('homeProjectCount').textContent = '0';
    showToast(err.message, 'error');
  }
}

async function pollActiveDeployments(projects) {
  const active = projects.filter((project) => project.lastDeploymentId && project.sourceType !== 'upload');
  if (!active.length) return;
  await Promise.all(active.map(async (project) => {
    try {
      const result = await userFetch(`/api/user/workspace/projects/${project._id}/deployments/${project.lastDeploymentId}`);
      const deployment = result.deployment;
      if (!activeUserDeploymentId || activeUserDeploymentId === String(project.lastDeploymentId)) {
        showUserDeploymentConsole(project, project.lastDeploymentId, deployment.status);
        fireboxSocket.emit('subscribe:deployment', String(project.lastDeploymentId));
        if (hydratedUserDeploymentId === String(project.lastDeploymentId) && deployment.logs?.length && !document.getElementById('userDeploymentTerminal').children.length) deployment.logs.forEach(appendUserDeploymentLog);
        updateUserDeploymentStatus(deployment.status, deployment);
      }
      if (['queued', 'building', 'deploying'].includes(deployment.status)) setTimeout(() => loadWorkspace(), 8000);
    } catch (_) { /* The deployment may be in the process of being created. */ }
  }));
}

fireboxSocket.on('log:line', (data) => {
  if (String(data.deploymentId) !== String(activeUserDeploymentId)) return;
  appendUserDeploymentLog(data);
});

fireboxSocket.on('deployment:status', async (data) => {
  if (String(data.deploymentId) !== String(activeUserDeploymentId)) return;
  updateUserDeploymentStatus(data.status);
  if (['success', 'failed', 'crashed'].includes(data.status)) {
    const result = await userFetch(`/api/user/workspace/projects/${activeUserProjectId}/deployments/${data.deploymentId}`).catch(() => null);
    updateUserDeploymentStatus(data.status, result?.deployment || {});
    await loadWorkspace();
  }
});

async function loadUserProjects() { await loadWorkspace(); }
function renderUserHistory(records) {
  const list = document.getElementById('userHistoryList');
  list.innerHTML = records.slice().reverse().map((record) => `<div class="card history-row"><div class="history-row-icon">↗</div><div class="history-row-main"><strong>${escapeHtml(record.projectName)}</strong><span>User deployment request · ${escapeHtml(record.provider)}</span></div><div class="history-row-status"><b>${escapeHtml(record.status || 'requested')}</b><small>${timeAgo(record.createdAt)}</small></div></div>`).join('');
  document.getElementById('userHistoryEmpty').style.display = records.length ? 'none' : 'block';
}
async function loadUserHistory() { await loadWorkspace(); }
document.getElementById('refreshUserHistory').addEventListener('click', loadUserHistory);

document.getElementById('chooseGithubOAuth').addEventListener('click', () => {
  document.getElementById('githubConnectionForm').style.display = 'none';
  document.getElementById('githubOAuthHint').style.display = 'block';
  window.location.href = '/api/user/workspace/github/oauth/start';
});
document.getElementById('chooseGithubToken').addEventListener('click', () => {
  document.getElementById('githubConnectionForm').style.display = 'block';
  document.getElementById('githubOAuthHint').style.display = 'none';
});

document.querySelectorAll('[data-create]').forEach((choice) => choice.addEventListener('click', () => {
  if (choice.dataset.create === 'github') {
    showUserSection('source');
    loadGithubConnection();
    return;
  }
  document.getElementById('githubCreateForm').style.display = 'none';
  document.getElementById('uploadCreateForm').style.display = 'block';
}));
document.querySelectorAll('[data-close-create]').forEach((button) => button.addEventListener('click', () => {
  document.getElementById('githubCreateForm').style.display = 'none';
  document.getElementById('uploadCreateForm').style.display = 'none';
}));

document.getElementById('githubCreateSubmit').addEventListener('click', async () => {
  const button = document.getElementById('githubCreateSubmit');
  const message = document.getElementById('githubCreateMessage');
  button.disabled = true; message.style.display = 'none';
  try {
    await userFetch('/api/user/workspace/projects', { method: 'POST', body: JSON.stringify({ name: document.getElementById('githubProjectName').value, repoUrl: document.getElementById('githubRepoUrl').value, branch: document.getElementById('githubBranch').value || 'main', provider: document.getElementById('githubProvider').value }) });
    showFormMessage('githubCreateMessage', 'GitHub project created in your user workspace.');
    document.getElementById('githubCreateForm').querySelectorAll('input').forEach((input) => { if (input.id !== 'githubBranch') input.value = ''; });
    await loadWorkspace();
  } catch (err) { showFormMessage('githubCreateMessage', err.message, true); } finally { button.disabled = false; }
});

document.getElementById('uploadCreateSubmit').addEventListener('click', async () => {
  const button = document.getElementById('uploadCreateSubmit');
  const message = document.getElementById('uploadCreateMessage');
  const files = document.getElementById('projectFolder').files;
  if (!files.length) return showFormMessage('uploadCreateMessage', 'Choose a project folder first.', true);
  const body = new FormData();
  body.append('name', document.getElementById('uploadProjectName').value);
  body.append('provider', document.getElementById('uploadProvider').value);
  [...files].forEach((file) => body.append('files', file, file.webkitRelativePath || file.name));
  button.disabled = true; message.style.display = 'none';
  try {
    const response = await fetch('/api/user/workspace/projects/upload', { method: 'POST', body });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
    showFormMessage('uploadCreateMessage', `Project created from ${result.uploadedFileCount} uploaded file${result.uploadedFileCount === 1 ? '' : 's'}.`);
    document.getElementById('uploadProjectName').value = ''; document.getElementById('projectFolder').value = '';
    await loadWorkspace();
  } catch (err) { showFormMessage('uploadCreateMessage', err.message, true); } finally { button.disabled = false; }
});

document.querySelectorAll('.user-provider-card').forEach((card) => card.addEventListener('click', () => {
  document.querySelectorAll('.user-provider-card').forEach((item) => item.classList.remove('selected'));
  card.classList.add('selected');
  const button = document.getElementById('submitDeployRequest');
  button.disabled = false;
  button.dataset.provider = card.dataset.provider;
  button.textContent = `Request ${card.dataset.provider[0].toUpperCase() + card.dataset.provider.slice(1)} deployment`;
}));

function showFormMessage(id, text, error = false) { const el = document.getElementById(id); el.className = error ? 'form-error' : 'form-success'; el.textContent = text; el.style.display = 'inline'; }

async function loadGithubConnection() {
  try {
    const connection = await userFetch('/api/user/workspace/github-connection');
    const dot = document.getElementById('githubStatusDot');
    document.getElementById('githubStatusTitle').textContent = connection.connected ? `GitHub connected as ${connection.username}` : 'GitHub is not connected';
    document.getElementById('githubStatusText').textContent = connection.connected ? `Connected using ${connection.authMethod === 'oauth' ? 'GitHub authorization' : 'personal access token'}.` : 'Choose GitHub authorization or a personal access token below.';
    dot.classList.toggle('connected', connection.connected);
    document.getElementById('connectedGithubImport').style.display = connection.connected ? 'block' : 'none';
    if (connection.authMethod === 'oauth') {
      document.getElementById('githubConnectionForm').style.display = 'none';
      document.getElementById('githubOAuthHint').style.display = 'none';
    }
    if (connection.connected) {
      document.getElementById('githubUsername').value = connection.username;
      await loadGithubRepositories();
    }
  } catch (err) { showFormMessage('githubConnectionMessage', err.message, true); }
}

async function loadGithubRepositories() {
  const select = document.getElementById('githubRepositorySelect');
  select.innerHTML = '<option value="">Loading repositories…</option>';
  try {
    const { repositories } = await userFetch('/api/user/workspace/github/repositories');
    select.innerHTML = repositories.length ? '<option value="">Choose an existing repository…</option>' : '<option value="">No accessible repositories found</option>';
    repositories.forEach((repo) => {
      const option = document.createElement('option');
      option.value = repo.fullName;
      option.textContent = `${repo.fullName}${repo.private ? ' · private' : ''}`;
      option.dataset.owner = repo.fullName.split('/')[0];
      option.dataset.repo = repo.name;
      option.dataset.branch = repo.defaultBranch || 'main';
      option.dataset.url = repo.htmlUrl;
      option.dataset.description = repo.description || '';
      option.dataset.language = repo.language || '';
      select.appendChild(option);
    });
  } catch (err) { select.innerHTML = `<option value="">Could not load repositories</option>`; showFormMessage('sourceFormMessage', err.message, true); }
}

async function inspectSelectedRepository() {
  const select = document.getElementById('githubRepositorySelect');
  const option = select.options[select.selectedIndex];
  if (!option || !option.dataset.owner) return;
  const meta = document.getElementById('githubRepositoryMeta');
  meta.style.display = 'block'; meta.textContent = 'Inspecting repository contents…';
  try {
    const data = await userFetch(`/api/user/workspace/github/repositories/${encodeURIComponent(option.dataset.owner)}/${encodeURIComponent(option.dataset.repo)}/inspect?branch=${encodeURIComponent(option.dataset.branch)}`);
    const detected = data.repository.detected;
    document.getElementById('sourceProjectName').value = option.dataset.repo;
    document.getElementById('sourceRepoUrl').value = option.dataset.url;
    document.getElementById('sourceBranch').value = data.repository.branch;
    meta.innerHTML = `<strong>${escapeHtml(detected.framework)}</strong> · ${escapeHtml(detected.packageManager)} · ${detected.hasDockerfile ? 'Dockerfile found' : 'No Dockerfile'} · ${detected.hasFireboxConfig ? 'fireboxdeploy.toml found' : 'standard detection'}<br><small>Build: ${escapeHtml(detected.buildCommand || 'auto-detect')} · Start: ${escapeHtml(detected.startCommand || 'auto-detect')}</small>`;
  } catch (err) { meta.textContent = err.message; }
}

document.getElementById('githubRepositorySelect').addEventListener('change', inspectSelectedRepository);
document.getElementById('refreshGithubRepos').addEventListener('click', loadGithubRepositories);

document.getElementById('githubConnectionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    await userFetch('/api/user/workspace/github-connection', { method: 'PUT', body: JSON.stringify({ username: document.getElementById('githubUsername').value, token: document.getElementById('githubToken').value }) });
    document.getElementById('githubToken').value = '';
    showFormMessage('githubConnectionMessage', 'GitHub connected securely.');
    await loadGithubConnection();
  } catch (err) { showFormMessage('githubConnectionMessage', err.message, true); } finally { button.disabled = false; }
});

document.getElementById('sourceImportSubmit').addEventListener('click', async () => {
  const button = document.getElementById('sourceImportSubmit'); button.disabled = true;
  const option = document.getElementById('githubRepositorySelect').selectedOptions[0];
  try {
    if (!option || !option.dataset.owner) throw new Error('Choose a GitHub repository first.');
    await userFetch('/api/user/workspace/github/import', { method: 'POST', body: JSON.stringify({ owner: option.dataset.owner, repo: option.dataset.repo, name: document.getElementById('sourceProjectName').value || option.dataset.repo, branch: document.getElementById('sourceBranch').value || option.dataset.branch || 'main', provider: document.getElementById('sourceProvider').value }) });
    showFormMessage('sourceFormMessage', 'GitHub repository inspected and project created with detected content.');
    await loadWorkspace();
  } catch (err) { showFormMessage('sourceFormMessage', err.message, true); } finally { button.disabled = false; }
});

document.getElementById('userDeployForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('submitDeployRequest'); button.disabled = true;
  try {
    await userFetch('/api/user/workspace/deployments', { method: 'POST', body: JSON.stringify({ projectName: document.getElementById('deployProjectName').value, repoUrl: document.getElementById('deployRepoUrl').value, provider: button.dataset.provider }) });
    showFormMessage('deployFormMessage', 'Deployment request saved in your user workspace.'); event.target.reset(); document.querySelectorAll('.user-provider-card').forEach((item) => item.classList.remove('selected')); button.textContent = 'Choose a provider first'; await loadWorkspace();
  } catch (err) { showFormMessage('deployFormMessage', err.message, true); } finally { button.disabled = false; }
});

document.getElementById('logoutBtn').addEventListener('click', async () => { await userFetch('/api/user-auth/logout', { method: 'POST' }); localStorage.removeItem('firebox_user_name'); localStorage.removeItem('firebox_user_email'); window.location.href = '/'; });
setIdentity();
loadGithubConnection();
const initialSection = window.location.hash.slice(1) || 'home';
showUserSection(initialSection, false);
loadWorkspace();
