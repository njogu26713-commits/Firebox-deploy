const projectId = window.location.pathname.split('/').pop();
let currentProject     = null;
let activeDeploymentId = null;

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'history') loadHistory();
    if (tab.dataset.tab === 'env')     loadEnvVars();
    if (tab.dataset.tab === 'domains') loadDomains();
  });
});

// ── Load project ──────────────────────────────────────────────────────────
async function loadProject() {
  try {
    const { project } = await apiFetch(`/api/projects/${projectId}`);
    currentProject = project;
    renderProject(project);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderProject(p) {
  document.title = `Firebox — ${p.name}`;
  document.getElementById('projectName').textContent = p.name;

  const beacon = document.getElementById('statusBeacon');
  beacon.dataset.status = p.status;
  beacon.innerHTML = `<span class="beacon-dot"></span>${p.status}`;

  document.getElementById('statStatus').textContent   = p.status;
  document.getElementById('statBranch').textContent   = p.githubBranch || 'main';
  document.getElementById('statDeployed').textContent = timeAgo(p.lastDeployedAt);

  // Domain display — prefer vpsUrl, then customDomain
  const domainEl = document.getElementById('projectDomain');
  const domain   = p.vpsUrl || p.customDomain || '';
  domainEl.textContent = domain || 'Not set';
  if (domain) domainEl.href = domain.startsWith('http') ? domain : `https://${domain}`;

  // Settings tab fields
  document.getElementById('settingBranch').value      = p.githubBranch  || '';
  document.getElementById('settingRootDir').value     = p.rootDirectory || '.';
  document.getElementById('settingBuild').value       = p.buildCommand  || '';
  document.getElementById('settingStart').value       = p.startCommand  || '';
  document.getElementById('settingDeployPath').value  = p.deployPath    || '';
  document.getElementById('settingPm2Name').value     = p.pm2Name       || '';
}

// ── Pipeline helpers ──────────────────────────────────────────────────────
// Pipeline steps: connect → clone → install → pm2
function setPipelineFromStatus(status) {
  const steps = document.querySelectorAll('.pipe-step');
  steps.forEach((s) => s.removeAttribute('data-state'));

  if (status === 'building') {
    // SSH connected + cloning/installing in progress
    setPipeStep('connect', 'done');
    setPipeStep('clone',   'done');
    setPipeStep('install', 'running');
  } else if (status === 'deploying') {
    setPipeStep('connect', 'done');
    setPipeStep('clone',   'done');
    setPipeStep('install', 'done');
    setPipeStep('pm2',     'running');
  } else if (status === 'success') {
    steps.forEach((s) => s.dataset.state = 'done');
  } else if (['failed', 'crashed'].includes(status)) {
    setPipeStep('connect', 'done');
  }
}

function setPipeStep(step, state) {
  const el = document.querySelector(`.pipe-step[data-step="${step}"]`);
  if (el) el.dataset.state = state;
}

// ── Env vars ──────────────────────────────────────────────────────────────
async function loadEnvVars() {
  try {
    const { envVars } = await apiFetch(`/api/projects/${projectId}/env`);
    const container   = document.getElementById('envRows');
    container.innerHTML = '';
    (envVars || []).forEach((e) => addEnvRow(e.key, e.value));
  } catch (err) {
    showToast(`Could not load env vars: ${err.message}`, 'error');
  }
}

function addEnvRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input placeholder="KEY"   class="env-key"   value="${escapeHtml(key)}" />
    <input placeholder="value" class="env-value" value="${escapeHtml(value)}" />
    <button type="button" class="btn btn-icon btn-ghost remove-env">✕</button>
  `;
  row.querySelector('.remove-env').addEventListener('click', () => row.remove());
  document.getElementById('envRows').appendChild(row);
}
document.getElementById('addEnvRow').addEventListener('click', () => addEnvRow());

document.getElementById('saveEnvBtn').addEventListener('click', async () => {
  const envVars = Array.from(document.querySelectorAll('#envRows .env-row')).map((row) => ({
    key:   row.querySelector('.env-key').value.trim(),
    value: row.querySelector('.env-value').value,
  })).filter((e) => e.key);

  try {
    await apiFetch(`/api/projects/${projectId}/env`, { method: 'PUT', body: JSON.stringify({ envVars }) });
    showToast('Variables saved. They will be applied on the next deployment.');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Domains ───────────────────────────────────────────────────────────────
async function loadDomains() {
  try {
    const { domains } = await apiFetch(`/api/projects/${projectId}/domains`);
    const container = document.getElementById('domainsList');
    if (!domains.length) {
      container.innerHTML = '<p class="text-muted" style="font-size:13px;">No URL set yet. Use the form below to add your app\'s public URL.</p>';
      return;
    }
    container.innerHTML = domains.map((d) => `
      <div class="domain-row">
        <span class="mono" style="font-size:13px;">${escapeHtml(d.domain)}</span>
        <span class="badge">${d.type === 'vps' ? '🖥 VPS' : '🌐 Custom'}</span>
        <button class="btn btn-icon btn-ghost btn-sm remove-domain" data-id="${d.id}">✕</button>
      </div>
    `).join('');

    container.querySelectorAll('.remove-domain').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/projects/${projectId}/domains/${btn.dataset.id}`, { method: 'DELETE' });
          showToast('URL removed.');
          loadDomains();
          loadProject();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('addDomainBtn').addEventListener('click', async () => {
  const domain = document.getElementById('newDomain').value.trim();
  if (!domain) return;
  try {
    await apiFetch(`/api/projects/${projectId}/domains`, {
      method: 'POST',
      body:   JSON.stringify({ domain, type: 'vps' }),
    });
    document.getElementById('newDomain').value = '';
    showToast('URL saved.');
    loadDomains();
    loadProject();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── History ───────────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const { deployments } = await apiFetch(`/api/projects/${projectId}/deployments`);
    const body = document.getElementById('historyBody');
    if (!deployments.length) {
      body.innerHTML = '<tr><td colspan="4" class="text-muted">No deployments yet.</td></tr>';
      return;
    }
    body.innerHTML = deployments.map((d) => `
      <tr>
        <td><span class="beacon" data-status="${statusToBeacon(d.status)}"><span class="beacon-dot"></span>${d.status}</span></td>
        <td>${d.triggeredBy || 'manual'}</td>
        <td>${d.url ? `<a href="${escapeHtml(d.url)}" target="_blank" class="mono" style="font-size:11px;color:var(--ember);">↗ open</a>` : '—'}</td>
        <td class="text-muted">${timeAgo(d.triggeredAt || d.createdAt)}</td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function statusToBeacon(s) {
  if (s === 'success')                               return 'running';
  if (['queued','building','deploying'].includes(s)) return 'building';
  if (['failed','crashed'].includes(s))              return 'failed';
  return 'idle';
}

// ── Settings ──────────────────────────────────────────────────────────────
document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const payload = {
    githubBranch:  document.getElementById('settingBranch').value.trim(),
    rootDirectory: document.getElementById('settingRootDir').value.trim() || '.',
    buildCommand:  document.getElementById('settingBuild').value.trim(),
    startCommand:  document.getElementById('settingStart').value.trim(),
    deployPath:    document.getElementById('settingDeployPath').value.trim(),
    pm2Name:       document.getElementById('settingPm2Name').value.trim(),
  };
  try {
    await apiFetch(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    showToast('Settings saved.');
    loadProject();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Deploy / Redeploy ─────────────────────────────────────────────────────
async function startDeploy(endpoint, label) {
  const terminal = document.getElementById('terminal');
  terminal.innerHTML = '';
  document.querySelectorAll('.pipe-step').forEach((s) => s.removeAttribute('data-state'));

  // Switch to logs tab
  document.querySelector('.tab[data-tab="logs"]').click();

  try {
    const result = await apiFetch(endpoint, { method: 'POST', body: '{}' });
    const { deploymentId } = result;
    activeDeploymentId = deploymentId;
    fireboxSocket.emit('subscribe:deployment', deploymentId);
    appendLogLine({ level: 'info', message: `${label} started — SSH pipeline running…`, ts: new Date() });
    setPipeStep('connect', 'running');
  } catch (err) {
    appendLogLine({ level: 'error', message: `Error: ${err.message}`, ts: new Date() });
    showToast(err.message, 'error');
  }
}

document.getElementById('deployBtn').addEventListener('click', () =>
  startDeploy(`/api/projects/${projectId}/deploy`, 'Deployment')
);
document.getElementById('redeployBtn').addEventListener('click', () =>
  startDeploy(`/api/projects/${projectId}/redeploy`, 'Redeploy')
);

// ── Fetch logs manually ───────────────────────────────────────────────────
document.getElementById('fetchLogsBtn').addEventListener('click', async () => {
  const lastDeployment = await apiFetch(`/api/projects/${projectId}/deployments`)
    .then((r) => r.deployments?.[0]).catch(() => null);
  if (!lastDeployment) { showToast('No deployments found', 'error'); return; }

  try {
    const { logs } = await apiFetch(`/api/deployments/${lastDeployment._id}/logs`);
    const terminal = document.getElementById('terminal');
    terminal.innerHTML = '';

    if (!logs || !logs.length) {
      appendLogLine({ level: 'info', message: 'No stored logs for this deployment.', ts: new Date() });
      return;
    }
    logs.forEach((l) => appendLogLine({ level: l.level || 'info', message: l.message, ts: l.ts }));
    setPipelineFromStatus(lastDeployment.status);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Live log streaming ────────────────────────────────────────────────────
function appendLogLine({ level, message, ts }) {
  const terminal = document.getElementById('terminal');
  const line     = document.createElement('div');
  line.className = `line ${level}`;
  const time = new Date(ts).toLocaleTimeString();
  line.innerHTML = `<span class="ts">${time}</span>${escapeHtml(message)}`;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

fireboxSocket.on('log:line', (data) => {
  if (data.deploymentId !== String(activeDeploymentId)) return;
  appendLogLine(data);
});

fireboxSocket.on('deployment:status', (data) => {
  if (data.deploymentId !== String(activeDeploymentId)) return;
  setPipelineFromStatus(data.status);
  if (['success', 'failed', 'crashed'].includes(data.status)) {
    const ok = data.status === 'success';
    showToast(ok ? '🔥 Deployment succeeded!' : `Deployment ${data.status}`, ok ? 'success' : 'error');
    loadProject();
    loadHistory();
  }
});

// ── Delete ────────────────────────────────────────────────────────────────
async function doDelete() {
  if (!confirm(`Delete "${currentProject?.name}"? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    showToast('Project deleted.');
    window.location.href = '/dashboard';
  } catch (err) {
    showToast(err.message, 'error');
  }
}
document.getElementById('deleteBtn').addEventListener('click',  doDelete);
document.getElementById('deleteBtn2').addEventListener('click', doDelete);

// ── Dashboard status push ─────────────────────────────────────────────────
fireboxSocket.emit('subscribe:dashboard');
fireboxSocket.on('project:status', (data) => {
  if (data.projectId === projectId) loadProject();
});

loadProject();
