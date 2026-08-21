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
  return `<div class="card project-card"><div class="project-card-head"><div><div class="project-name">${escapeHtml(project.name)}</div><div class="project-type">User workspace project</div></div><div class="beacon"><span class="beacon-dot"></span>connected</div></div><div class="project-domain">${escapeHtml(project.repoUrl)}</div><div class="project-meta"><span>Branch <b>${escapeHtml(project.branch || 'main')}</b></span><span>Provider <b>${escapeHtml(project.provider || 'railway')}</b></span></div></div>`;
}

async function loadWorkspace() {
  try {
    const { workspace } = await userFetch('/api/user/workspace');
    const projects = workspace.projects || [];
    document.getElementById('homeProjectCount').textContent = projects.length;
    document.getElementById('userProjectsGrid').innerHTML = projects.map(userProjectCard).join('');
    document.getElementById('userProjectsEmpty').style.display = projects.length ? 'none' : 'block';
    renderUserHistory(workspace.activity || []);
  } catch (err) {
    document.getElementById('homeProjectCount').textContent = '0';
    showToast(err.message, 'error');
  }
}

async function loadUserProjects() { await loadWorkspace(); }
function renderUserHistory(records) {
  const list = document.getElementById('userHistoryList');
  list.innerHTML = records.slice().reverse().map((record) => `<div class="card history-row"><div class="history-row-icon">↗</div><div class="history-row-main"><strong>${escapeHtml(record.projectName)}</strong><span>User deployment request · ${escapeHtml(record.provider)}</span></div><div class="history-row-status"><b>${escapeHtml(record.status || 'requested')}</b><small>${timeAgo(record.createdAt)}</small></div></div>`).join('');
  document.getElementById('userHistoryEmpty').style.display = records.length ? 'none' : 'block';
}
async function loadUserHistory() { await loadWorkspace(); }
document.getElementById('refreshUserHistory').addEventListener('click', loadUserHistory);

document.querySelectorAll('.user-provider-card').forEach((card) => card.addEventListener('click', () => {
  document.querySelectorAll('.user-provider-card').forEach((item) => item.classList.remove('selected'));
  card.classList.add('selected');
  const button = document.getElementById('submitDeployRequest');
  button.disabled = false;
  button.dataset.provider = card.dataset.provider;
  button.textContent = `Request ${card.dataset.provider[0].toUpperCase() + card.dataset.provider.slice(1)} deployment`;
}));

function showFormMessage(id, text, error = false) { const el = document.getElementById(id); el.className = error ? 'form-error' : 'form-success'; el.textContent = text; el.style.display = 'inline'; }

document.getElementById('userSourceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    await userFetch('/api/user/workspace/projects', { method: 'POST', body: JSON.stringify({ name: document.getElementById('sourceProjectName').value, repoUrl: document.getElementById('sourceRepoUrl').value, branch: document.getElementById('sourceBranch').value || 'main', provider: 'railway' }) });
    showFormMessage('sourceFormMessage', 'Repository saved in your user workspace.'); event.target.reset(); document.getElementById('sourceBranch').value = 'main'; await loadWorkspace();
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

document.getElementById('logoutBtn').addEventListener('click', () => { localStorage.removeItem('firebox_user_name'); localStorage.removeItem('firebox_user_email'); window.location.href = '/'; });
setIdentity();
const initialSection = window.location.hash.slice(1) || 'home';
showUserSection(initialSection, false);
loadWorkspace();
