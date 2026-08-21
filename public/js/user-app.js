const userSections = {
  home: ['Your workspace', 'One place to plan and ship your projects.'],
  projects: ['Projects', 'Your connected applications.'],
  source: ['Source Control', 'Connect a repository to your workspace.'],
  history: ['History', 'Recent deployment activity.'],
  deploy: ['Deploy', 'Choose where to deploy your project.'],
  settings: ['Settings', 'Manage your workspace preferences.'],
};

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

async function loadUserIdentity() {
  try {
    const { user } = await apiFetch('/api/auth/me');
    ['userName', 'settingsUserName'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = user.name || 'User'; });
    ['userEmail', 'settingsUserEmail'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = user.email || ''; });
    const { projects } = await apiFetch('/api/projects');
    document.getElementById('homeProjectCount').textContent = projects.length;
  } catch (_) {
    window.location.href = '/login';
  }
}

function userProjectCard(project) {
  return `<div class="card project-card"><div class="project-card-head"><div><div class="project-name">${escapeHtml(project.name)}</div><div class="project-type">${escapeHtml(project.type || 'Application')}</div></div><div class="beacon" data-status="${escapeHtml(project.status || 'idle')}"><span class="beacon-dot"></span>${escapeHtml(project.status || 'idle')}</div></div><div class="project-domain">${escapeHtml(project.repoUrl || project.githubRepoFullName || 'Repository connected')}</div><div class="project-meta"><span>Branch <b>${escapeHtml(project.githubBranch || 'main')}</b></span><span>Updated <b>${timeAgo(project.updatedAt)}</b></span></div></div>`;
}

async function loadUserProjects() {
  try {
    const { projects } = await apiFetch('/api/projects');
    const grid = document.getElementById('userProjectsGrid');
    grid.innerHTML = projects.map(userProjectCard).join('');
    document.getElementById('userProjectsEmpty').style.display = projects.length ? 'none' : 'block';
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadUserHistory() {
  try {
    const { projects } = await apiFetch('/api/projects');
    const records = [];
    for (const project of projects) {
      try {
        const result = await apiFetch(`/api/projects/${project._id}/deployments`);
        (result.deployments || []).forEach((deployment) => records.push({ ...deployment, projectName: project.name }));
      } catch (_) { /* one unavailable history should not block the whole page */ }
    }
    records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    document.getElementById('userHistoryList').innerHTML = records.slice(0, 50).map((record) => `<div class="card history-row"><div class="history-row-icon ${record.status === 'success' ? 'success' : record.status === 'failed' ? 'failed' : ''}">${record.status === 'success' ? '✓' : record.status === 'failed' ? '×' : '↗'}</div><div class="history-row-main"><strong>${escapeHtml(record.projectName)}</strong><span>${escapeHtml(record.trigger || 'Manual deploy')} · ${escapeHtml(record.branch || 'main')}</span></div><div class="history-row-status"><b>${escapeHtml(record.status || 'queued')}</b><small>${timeAgo(record.createdAt)}</small></div></div>`).join('');
    document.getElementById('userHistoryEmpty').style.display = records.length ? 'none' : 'block';
  } catch (err) { showToast(err.message, 'error'); }
}

document.getElementById('refreshUserHistory').addEventListener('click', loadUserHistory);

document.querySelectorAll('.user-provider-card').forEach((card) => card.addEventListener('click', () => {
  document.querySelectorAll('.user-provider-card').forEach((item) => item.classList.remove('selected'));
  card.classList.add('selected');
  document.getElementById('submitDeployRequest').disabled = false;
  document.getElementById('submitDeployRequest').dataset.provider = card.dataset.provider;
  document.getElementById('submitDeployRequest').textContent = `Request ${card.dataset.provider[0].toUpperCase() + card.dataset.provider.slice(1)} deployment`;
}));

async function submitRequest(payload, messageId, button) {
  const message = document.getElementById(messageId);
  message.style.display = 'none';
  button.disabled = true;
  try {
    const response = await fetch('/api/deployment-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    message.className = 'form-success';
    message.textContent = 'Request sent to the admin team.';
    message.style.display = 'inline';
  } catch (err) {
    message.className = 'form-error';
    message.textContent = err.message;
    message.style.display = 'inline';
  } finally { button.disabled = false; }
}

document.getElementById('userSourceForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitRequest({ requesterName: document.getElementById('userName').textContent, requesterEmail: document.getElementById('userEmail').textContent, projectName: document.getElementById('sourceProjectName').value, provider: 'railway', repoUrl: document.getElementById('sourceRepoUrl').value, branch: document.getElementById('sourceBranch').value || 'main', notes: document.getElementById('sourceNotes').value }, 'sourceFormMessage', event.target.querySelector('button'));
});

document.getElementById('userDeployForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = document.getElementById('submitDeployRequest');
  submitRequest({ requesterName: document.getElementById('userName').textContent, requesterEmail: document.getElementById('userEmail').textContent, projectName: document.getElementById('deployProjectName').value, provider: button.dataset.provider, repoUrl: document.getElementById('deployRepoUrl').value, branch: 'main', notes: '' }, 'deployFormMessage', button);
});

document.getElementById('logoutBtn').addEventListener('click', async () => { await apiFetch('/api/auth/logout', { method: 'POST' }); localStorage.removeItem('firebox_token'); window.location.href = '/login'; });

const initialSection = window.location.hash.slice(1) || 'home';
showUserSection(initialSection, false);
loadUserIdentity();
