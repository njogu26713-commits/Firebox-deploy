/**
 * azure.js — FireboxDeploy Azure dashboard frontend
 */

// ── State ──────────────────────────────────────────────────────────────────
let azureConfigured = false;
let allLiveApps = [];
let allResourceGroups = [];
let currentDomainsApp = { rg: '', name: '' };
let _regionsCache = null;

// Current deploy log data (for the log viewer modal)
let _currentLogData = { logs: [], deployment: null };
let _currentLogFilter = 'all';

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  try {
    const { user } = await apiFetch('/api/auth/me');
    document.getElementById('userName').textContent  = user.name;
    document.getElementById('userEmail').textContent = user.email;
  } catch {
    window.location.href = '/login';
    return;
  }

  const status = await apiFetch('/api/azure/status').catch(() => ({ status: 'unconfigured', configured: false }));
  azureConfigured = status.configured;

  updateStatusBar(status);
  updateSettingsBadge(status);

  document.getElementById('mainContent').style.display = 'block';

  if (!azureConfigured) {
    document.getElementById('notConfiguredBanner').style.display = 'none';
    showTab('settings');
    const panel = document.getElementById('panel-settings');
    if (panel && !panel.querySelector('.azure-setup-notice')) {
      const notice = document.createElement('div');
      notice.className = 'azure-setup-notice';
      notice.innerHTML = '<span>☁</span> Enter your Azure Service Principal credentials below to start deploying apps.';
      panel.insertBefore(notice, panel.firstChild);
    }
    return;
  }

  loadOverview();
  loadRegions();
  populateAppSelectors();
}

function updateStatusBar(status) {
  const bar = document.getElementById('azureStatusBar');
  const banner = document.getElementById('connectionBanner');

  if (!status.configured) {
    bar.textContent = 'Not connected — configure Azure in Settings';
    return;
  }

  if (status.status === 'connected') {
    bar.textContent = '✓ Connected to Azure';
    bar.style.color = 'var(--teal)';
    banner.style.display = 'none';
  } else if (status.status === 'failed') {
    bar.textContent = '✗ Azure connection failed';
    bar.style.color = 'var(--danger)';
    banner.className = 'railway-banner banner-error';
    banner.style.display = 'flex';
    document.getElementById('bannerIcon').textContent = '⚠';
    document.getElementById('bannerTitle').textContent = 'Azure Connection Failed';
    document.getElementById('bannerMsg').textContent = status.statusError || 'Check credentials in Settings.';
  } else {
    bar.textContent = 'Azure — not configured';
  }
}

// ── Regions ────────────────────────────────────────────────────────────────

async function loadRegions(force = false) {
  if (!azureConfigured) return;

  if (!force && _regionsCache) {
    populateRegionSelects(_regionsCache);
    return;
  }

  ['dm-region', 'rg-location'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">⏳ Loading regions…</option>';
  });
  const hint = document.getElementById('regionsHint');
  if (hint) { hint.style.display = 'none'; hint.textContent = ''; }

  try {
    const endpoint = force ? '/api/azure/locations?refresh=true' : '/api/azure/locations';
    const result   = await apiFetch(endpoint);
    const locations = result.locations || [];

    _regionsCache = locations;
    populateRegionSelects(locations);

    if (!locations.length) {
      const msg = result.message || 'No deployment regions are available for this subscription.';
      if (hint) { hint.textContent = msg; hint.style.display = 'block'; }
    } else if (force) {
      showToast(`${locations.length} regions loaded`, 'success');
    }
  } catch (err) {
    const msg = `Could not load regions: ${err.message}`;
    ['dm-region', 'rg-location'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">${escapeHtml(msg)}</option>`;
    });
    if (hint) { hint.textContent = msg; hint.style.display = 'block'; }
    if (force) showToast(msg, 'error');
  }
}

function populateRegionSelects(locations) {
  if (!locations || !locations.length) {
    const msg = 'No deployment regions are available for this subscription.';
    ['dm-region', 'rg-location'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">${escapeHtml(msg)}</option>`;
    });
    return;
  }
  const options = locations
    .map((loc) => `<option value="${escapeHtml(loc.name)}">${escapeHtml(loc.displayName)}</option>`)
    .join('');
  ['dm-region', 'rg-location'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = options;
  });
}

function updateSettingsBadge(status) {
  const badge = document.getElementById('azureStatusBadge');
  if (!status.configured) {
    badge.textContent = 'Unconfigured';
    badge.className   = 'token-badge';
  } else if (status.status === 'connected') {
    badge.textContent = '✓ Connected';
    badge.className   = 'token-badge azure-connected';
  } else {
    badge.textContent = '✗ Failed';
    badge.className   = 'token-badge failed';
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function showTab(name) {
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));

  if (name === 'apps')             loadLiveApps();
  if (name === 'resource-groups')  loadResourceGroups();
  if (name === 'cost')             loadCost();
  if (name === 'env-vars' && !document.querySelector('#envVarRows')) loadEnvVars();
}

document.getElementById('azureTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) showTab(tab.dataset.tab);
});

// Log sub-tabs
document.getElementById('logSubTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-subtab]');
  if (!tab) return;
  const name = tab.dataset.subtab;
  document.querySelectorAll('#logSubTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.subtab === name));
  document.getElementById('subpanel-activity').style.display      = name === 'activity' ? '' : 'none';
  document.getElementById('subpanel-deploy-history').style.display = name === 'deploy-history' ? '' : 'none';
  if (name === 'deploy-history') loadDeployHistory();
});

// ── Overview ───────────────────────────────────────────────────────────────

async function loadOverview() {
  try {
    const d = await apiFetch('/api/azure/dashboard');

    const sub = d.subscription || {};
    document.getElementById('subName').textContent   = sub.displayName || '—';
    document.getElementById('subRegion').textContent = sub.subscriptionPolicies?.locationPlacementId?.replace('Public_', '') || '—';
    document.getElementById('rgCount').textContent   = (d.resourceGroups || []).length;
    document.getElementById('appCount').textContent  = (d.apps || []).length;
    document.getElementById('vmCount').textContent   = (d.vms || []).length;
    document.getElementById('storageCount').textContent = (d.storageAccounts || []).length;
    document.getElementById('azStatus').textContent  = 'Operational';
    document.getElementById('azStatus').style.color  = 'var(--teal)';
  } catch (err) {
    console.warn('Dashboard summary error:', err.message);
  }

  apiFetch('/api/azure/cost').then((r) => {
    const rows = r.cost?.properties?.rows || [];
    const total = rows.reduce((sum, row) => sum + (parseFloat(row[0]) || 0), 0);
    document.getElementById('monthlyCost').textContent = `$${total.toFixed(2)}`;
  }).catch(() => { document.getElementById('monthlyCost').textContent = '—'; });

  loadTrackedApps();
}

async function loadTrackedApps() {
  const grid  = document.getElementById('trackedAppsGrid');
  const empty = document.getElementById('trackedAppsEmpty');
  try {
    const { apps } = await apiFetch('/api/azure/tracked-apps');
    if (!apps.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = apps.map(appCard).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

function appCard(app) {
  const runtimeLabel = { nodejs: 'Node.js', python: 'Python', php: 'PHP', java: 'Java', go: 'Go', dotnet: '.NET' };
  return `
  <div class="card azure-app-card" onclick="openAppDetail('${escapeHtml(app.resourceGroup)}','${escapeHtml(app.name)}','${escapeHtml(app._id)}')">
    <div class="azure-app-card-head">
      <div>
        <div class="project-name">${escapeHtml(app.name)}</div>
        <div class="project-type">${runtimeLabel[app.runtime] || app.runtime} · ${escapeHtml(app.resourceGroup)}</div>
      </div>
      <div class="beacon" data-status="${app.status}">
        <span class="beacon-dot"></span>${app.status}
      </div>
    </div>
    ${app.azureUrl ? `<div class="project-domain"><a href="https://${escapeHtml(app.azureUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--azure);">${escapeHtml(app.azureUrl)}</a></div>` : ''}
    <div class="project-meta">
      <span>Region <b>${escapeHtml(app.region || '—')}</b></span>
      <span>Tier <b>${escapeHtml(app.planSku || '—')}</b></span>
      <span class="azure-badge">☁ Azure</span>
    </div>
    <div class="project-meta" style="margin-top:6px;">
      <button class="btn btn-ghost btn-sm" style="font-size:11px;" onclick="event.stopPropagation();openDeployHistoryForApp('${escapeHtml(app.resourceGroup)}','${escapeHtml(app.name)}')">📋 Deploy Logs</button>
    </div>
  </div>`;
}

// ── Live Apps ──────────────────────────────────────────────────────────────

async function loadLiveApps() {
  const wrap = document.getElementById('liveAppsTable');
  wrap.innerHTML = '<div class="azure-loading"><div class="spinner"></div>Loading Azure apps…</div>';
  try {
    const { apps } = await apiFetch('/api/azure/apps');
    allLiveApps = apps || [];
    if (!apps.length) {
      wrap.innerHTML = '<div class="empty"><h3>No App Services</h3><p>Deploy your first app to get started.</p></div>';
      return;
    }
    wrap.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden;">
        <table class="azure-apps-table">
          <thead><tr><th>Name</th><th>URL</th><th>Runtime</th><th>State</th><th>Region</th><th>Created</th><th></th></tr></thead>
          <tbody>${apps.map(liveAppRow).join('')}</tbody>
        </table>
      </div>`;
  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

function liveAppRow(app) {
  const props  = app.properties || {};
  const url    = props.defaultHostName || '';
  const state  = props.state || 'Unknown';
  const runtime = (props.siteConfig?.linuxFxVersion || '').split('|')[0] || '—';
  const region  = app.location || '—';
  const created = app.properties?.createdTime ? new Date(app.properties.createdTime).toLocaleDateString() : '—';
  const [rg, name] = parseAzureId(app.id || '');

  const stateColor = { Running: 'var(--teal)', Stopped: 'var(--muted)', Failed: 'var(--danger)' }[state] || 'var(--muted)';

  return `
  <tr>
    <td class="app-name-cell">${escapeHtml(app.name || '—')}</td>
    <td class="app-url-cell">${url ? `<a href="https://${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>` : '—'}</td>
    <td><span class="badge">${escapeHtml(runtime)}</span></td>
    <td><span style="color:${stateColor};font-weight:600;">${escapeHtml(state)}</span></td>
    <td>${escapeHtml(region)}</td>
    <td>${escapeHtml(created)}</td>
    <td>
      <div class="app-actions">
        <button class="btn btn-ghost btn-sm" title="Start"  onclick="appAction('start','${escapeHtml(rg)}','${escapeHtml(app.name)}')">▶</button>
        <button class="btn btn-ghost btn-sm" title="Stop"   onclick="appAction('stop','${escapeHtml(rg)}','${escapeHtml(app.name)}')">■</button>
        <button class="btn btn-ghost btn-sm" title="Restart" onclick="appAction('restart','${escapeHtml(rg)}','${escapeHtml(app.name)}')">↻</button>
        <button class="btn btn-ghost btn-sm" title="Deploy Logs" onclick="openDeployHistoryForApp('${escapeHtml(rg)}','${escapeHtml(app.name)}')">📋</button>
        <button class="btn btn-danger btn-sm" title="Delete" onclick="confirmDeleteApp('${escapeHtml(rg)}','${escapeHtml(app.name)}')">🗑</button>
      </div>
    </td>
  </tr>`;
}

async function appAction(action, rg, name) {
  try {
    await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    showToast(`App ${action}ed successfully`, 'success');
    loadLiveApps();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function confirmDeleteApp(rg, name) {
  if (!confirm(`Delete app "${name}" from Azure? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('App deleted', 'success');
    loadLiveApps();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Resource Groups ────────────────────────────────────────────────────────

async function loadResourceGroups() {
  const tbody = document.getElementById('rgTableBody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">Loading…</td></tr>';
  try {
    const { resourceGroups } = await apiFetch('/api/azure/resource-groups');
    allResourceGroups = resourceGroups || [];
    renderRgTable(allResourceGroups);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger);padding:14px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderRgTable(groups) {
  const tbody = document.getElementById('rgTableBody');
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No resource groups found</td></tr>';
    return;
  }
  tbody.innerHTML = groups.map((rg) => {
    const props  = rg.properties || {};
    const tags   = Object.keys(rg.tags || {}).join(', ') || '—';
    return `
    <tr>
      <td style="font-weight:600;">${escapeHtml(rg.name)}</td>
      <td>${escapeHtml(rg.location)}</td>
      <td><span style="color:${props.provisioningState === 'Succeeded' ? 'var(--teal)' : 'var(--muted)'};">${escapeHtml(props.provisioningState || '—')}</span></td>
      <td style="font-size:12px;color:var(--muted-2);">${escapeHtml(tags)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="confirmDeleteRg('${escapeHtml(rg.name)}')">Delete</button></td>
    </tr>`;
  }).join('');
}

function filterRgs() {
  const q = document.getElementById('rgSearch').value.toLowerCase();
  renderRgTable(allResourceGroups.filter((rg) => rg.name.toLowerCase().includes(q) || rg.location.toLowerCase().includes(q)));
}

async function confirmDeleteRg(name) {
  if (!confirm(`Delete resource group "${name}"? This permanently deletes ALL resources inside it.`)) return;
  try {
    await apiFetch(`/api/azure/resource-groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('Resource group deletion initiated', 'success');
    loadResourceGroups();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Monitoring ─────────────────────────────────────────────────────────────

async function loadMetrics() {
  const sel   = document.getElementById('monitorApp');
  const range = document.getElementById('monitorRange').value;
  const val   = sel.value;
  if (!val) { showToast('Select an app first', 'error'); return; }
  const { rg, name } = JSON.parse(val);

  const panel = document.getElementById('metricsPanel');
  panel.innerHTML = '<div class="azure-loading"><div class="spinner"></div>Loading metrics…</div>';

  try {
    const { metrics } = await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/metrics?range=${range}`);
    if (!metrics || !metrics.length) {
      panel.innerHTML = '<div class="empty"><p>No metric data available for this app / range.</p></div>';
      return;
    }
    panel.innerHTML = `<div class="metrics-grid">${metrics.map(metricCard).join('')}</div>`;
  } catch (err) {
    panel.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

function metricCard(metric) {
  const name       = metric.name?.localizedValue || metric.name?.value || '—';
  const timeseries = metric.timeseries?.[0]?.data || [];
  const values     = timeseries.map((p) => p.average ?? p.total ?? 0).filter((v) => v != null);
  const latest     = values.length ? values[values.length - 1] : 0;
  const max        = Math.max(...values, 1);
  const unit       = metric.unit || '';

  const bars = values.slice(-30).map((v) => {
    const pct = Math.round((v / max) * 100);
    return `<div class="metric-bar" style="height:${Math.max(pct, 2)}%" title="${v.toFixed(2)} ${unit}"></div>`;
  }).join('');

  return `
  <div class="metric-card">
    <div class="metric-card-title">${escapeHtml(name)}</div>
    <div class="metric-value">${formatMetricValue(latest, unit)} <span style="font-size:13px;color:var(--muted);">${escapeHtml(unit)}</span></div>
    <div class="metric-chart">${bars || '<span style="color:var(--muted-2);font-size:12px;">No data</span>'}</div>
  </div>`;
}

function formatMetricValue(v, unit) {
  if (unit === 'Bytes') return v > 1048576 ? `${(v / 1048576).toFixed(1)}MB` : v > 1024 ? `${(v / 1024).toFixed(1)}KB` : `${v.toFixed(0)}B`;
  if (unit === 'Percent') return `${v.toFixed(1)}%`;
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return v.toFixed(2);
}

// ── Environment Variables ──────────────────────────────────────────────────

let currentEnvApp = { rg: '', name: '' };

function setEnvVarsApp(rg, name) {
  const sel = document.getElementById('envVarsApp');
  if (!sel) return;
  for (const opt of sel.options) {
    try {
      const val = JSON.parse(opt.value);
      if (val.rg === rg && val.name === name) { sel.value = opt.value; break; }
    } catch { /* skip */ }
  }
  currentEnvApp = { rg, name };
  loadEnvVars();
}

async function loadEnvVars() {
  const sel = document.getElementById('envVarsApp');
  const val = sel?.value;
  const panel = document.getElementById('envVarsPanel');

  let rg, name;
  if (val) {
    const parsed = JSON.parse(val);
    rg   = parsed.rg;
    name = parsed.name;
    currentEnvApp = { rg, name };
  } else if (currentEnvApp.rg) {
    rg   = currentEnvApp.rg;
    name = currentEnvApp.name;
  } else {
    showToast('Select an app first', 'error');
    return;
  }

  panel.innerHTML = '<div class="azure-loading"><div class="spinner"></div>Loading environment variables…</div>';

  try {
    const { settings } = await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/env`);
    renderEnvVars(settings, rg, name);
  } catch (err) {
    panel.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

function renderEnvVars(settings, rg, name) {
  const panel = document.getElementById('envVarsPanel');
  const entries = Object.entries(settings || {});
  const rows = entries.map(([k, v]) => envVarRow(k, v)).join('');
  panel.innerHTML = `
  <div class="card" style="padding:20px;">
    <div class="env-vars-header">
      <div style="font-size:13px;color:var(--muted);">${entries.length} variable${entries.length !== 1 ? 's' : ''} — changes are applied immediately on save.</div>
    </div>
    <div id="envVarRows" style="margin-top:16px;">${rows}</div>
    <div class="env-vars-footer">
      <button class="btn btn-ghost btn-sm" onclick="addEnvVarRow()">＋ Add Variable</button>
      <div class="gap-8">
        <button class="btn btn-primary btn-sm" onclick="saveEnvVars('${escapeHtml(rg)}','${escapeHtml(name)}')">Save Changes</button>
      </div>
    </div>
  </div>`;
}

function envVarRow(key = '', value = '') {
  return `
  <div class="env-var-row">
    <input class="env-key" placeholder="KEY" value="${escapeHtml(key)}" spellcheck="false" autocomplete="off" />
    <input class="env-val" placeholder="value" value="${escapeHtml(value)}" spellcheck="false" autocomplete="off" />
    <button class="btn btn-ghost btn-sm btn-icon env-remove" title="Remove" onclick="this.closest('.env-var-row').remove()">✕</button>
  </div>`;
}

function addEnvVarRow() {
  const container = document.getElementById('envVarRows');
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = envVarRow();
  container.appendChild(div.firstElementChild);
  container.querySelector('.env-var-row:last-child .env-key')?.focus();
}

async function saveEnvVars(rg, name) {
  const rows = document.querySelectorAll('#envVarRows .env-var-row');
  const settings = {};
  let hasError = false;
  rows.forEach((row) => {
    const key = row.querySelector('.env-key').value.trim();
    const val = row.querySelector('.env-val').value;
    if (key) settings[key] = val;
    else if (val) hasError = true;
  });
  if (hasError) { showToast('All keys must be non-empty', 'error'); return; }

  try {
    await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/env`, {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
    showToast('Environment variables saved — app will restart to apply changes', 'success');
    loadEnvVars();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Scaling ────────────────────────────────────────────────────────────────

let _scaleContext = { rg: '', planName: '' };

async function openScaleModal(rg, appName) {
  const app = allLiveApps.find((a) => a.name === appName);
  const planId = app?.properties?.serverFarmId || '';
  const planName = planId.split('/').pop() || `${appName}-plan`;
  _scaleContext = { rg, planName };

  document.getElementById('scalePlanName').textContent = planName;

  try {
    const { instanceCount } = await apiFetch(`/api/azure/plans/${encodeURIComponent(rg)}/${encodeURIComponent(planName)}/instance-count`);
    document.getElementById('scaleSlider').value = instanceCount;
    document.getElementById('scaleCountDisplay').textContent = instanceCount;
  } catch {
    document.getElementById('scaleSlider').value = 1;
    document.getElementById('scaleCountDisplay').textContent = 1;
  }

  document.getElementById('scaleModal').classList.add('open');
}

document.getElementById('confirmScaleBtn').addEventListener('click', async () => {
  const { rg, planName } = _scaleContext;
  if (!rg || !planName) { showToast('No plan selected', 'error'); return; }
  const count = parseInt(document.getElementById('scaleSlider').value, 10);
  try {
    await apiFetch(`/api/azure/plans/${encodeURIComponent(rg)}/${encodeURIComponent(planName)}/scale`, {
      method: 'POST',
      body: JSON.stringify({ instanceCount: count }),
    });
    showToast(`Scaled to ${count} instance${count !== 1 ? 's' : ''}`, 'success');
    closeModal('scaleModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Activity Logs ───────────────────────────────────────────────────────────

async function loadLogs() {
  const sel = document.getElementById('logsApp');
  const val = sel.value;
  if (!val) { showToast('Select an app first', 'error'); return; }
  const { rg, name } = JSON.parse(val);

  const term = document.getElementById('logsTerminal');
  term.innerHTML = '<span style="color:var(--muted-2);">Loading logs…</span>';

  try {
    const { logs } = await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/logs`);
    if (!logs || !logs.length) {
      term.innerHTML = '<span style="color:var(--muted-2);">No activity found in the last 7 days for this app.</span>';
      return;
    }

    const lines = [];
    for (const entry of logs) {
      const props = entry.properties || {};
      const startTs = props.startTime ? new Date(props.startTime).toLocaleString() : '';
      const status  = (typeof props.status === 'object'
        ? props.status?.localizedValue || props.status?.value || 'unknown'
        : props.status || 'unknown').toLowerCase();
      const author  = props.author || '';

      if (entry._type === 'activity') {
        const level   = (props.level || 'Informational').toLowerCase();
        const cls     = level === 'error' || level === 'critical' ? 'error'
                      : level === 'warning' ? 'warn'
                      : status === 'failed' ? 'error'
                      : 'info';
        const icon    = cls === 'error' ? '✕' : cls === 'warn' ? '⚠' : '●';
        const opName  = entry.name || 'Operation';
        const msg     = props.message || opName;
        lines.push(
          `<div class="line ${cls}">` +
          `<span class="ts">${escapeHtml(startTs)}</span>` +
          `${icon} ${escapeHtml(opName)}` +
          (author ? ` <span style="opacity:.6;font-size:.85em">by ${escapeHtml(author)}</span>` : '') +
          (msg !== opName ? ` — ${escapeHtml(msg)}` : '') +
          `</div>`
        );
      } else {
        const endTs   = props.endTime ? new Date(props.endTime).toLocaleString() : '';
        const message = props.message || props.deploymentLogs || `Deployment ${entry.name || ''}`;
        const cls     = status === 'success' ? 'success' : (status === 'failed') ? 'error' : 'info';

        lines.push(`<div class="line ${cls}"><span class="ts">${escapeHtml(startTs)}</span>▶ Deployment started${author ? ` by ${escapeHtml(author)}` : ''}</div>`);
        lines.push(`<div class="line ${cls}"><span class="ts"></span>${escapeHtml(message)}</div>`);

        if (Array.isArray(entry.logEntries) && entry.logEntries.length) {
          for (const le of entry.logEntries) {
            const ep      = le.properties || {};
            const leTs    = ep.logTime ? new Date(ep.logTime).toLocaleString() : '';
            const leMsg   = ep.message || '';
            const leCls   = ep.type === 'Error' ? 'error' : 'info';
            if (leMsg) {
              lines.push(`<div class="line ${leCls}" style="padding-left:24px;"><span class="ts">${escapeHtml(leTs)}</span>${escapeHtml(leMsg)}</div>`);
            }
          }
        }

        if (endTs) {
          lines.push(`<div class="line ${cls}"><span class="ts">${escapeHtml(endTs)}</span>■ Deployment ${status}${props.complete ? '' : ' (in progress)'}</div>`);
        }
      }
      lines.push('<div class="line" style="border-top:1px solid rgba(255,255,255,.06);margin:4px 0;padding:0;"></div>');
    }

    term.innerHTML = lines.join('');
    term.scrollTop = term.scrollHeight;
  } catch (err) {
    term.innerHTML = `<div class="line error">${escapeHtml(err.message)}</div>`;
  }
}

// ── Deploy History ─────────────────────────────────────────────────────────

let _historyContext = { rg: '', name: '' };

async function loadDeployHistory() {
  const sel  = document.getElementById('historyApp');
  const val  = sel?.value;
  const panel = document.getElementById('deployHistoryPanel');

  let rg, name;
  if (val) {
    try { const p = JSON.parse(val); rg = p.rg; name = p.name; } catch { /* skip */ }
  } else if (_historyContext.rg) {
    rg = _historyContext.rg; name = _historyContext.name;
  }

  if (!rg || !name) {
    panel.innerHTML = '<div class="empty"><p>Select an app to view its deployment history.</p></div>';
    return;
  }
  _historyContext = { rg, name };

  panel.innerHTML = '<div class="azure-loading"><div class="spinner"></div>Loading deployment history…</div>';

  try {
    const { deployments } = await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/deploy-history`);
    if (!deployments || !deployments.length) {
      panel.innerHTML = '<div class="empty"><p>No deployment records found for this app.</p><p style="font-size:12px;color:var(--muted-2);">FireboxDeploy records deployments triggered from the dashboard. Deployments made outside FireboxDeploy will not appear here.</p></div>';
      return;
    }

    panel.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden;">
        <table>
          <thead><tr><th>Started</th><th>Branch</th><th>Status</th><th>Failed Step</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            ${deployments.map(deployHistoryRow).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    panel.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

function deployHistoryRow(dep) {
  const started  = dep.startedAt ? new Date(dep.startedAt).toLocaleString() : '—';
  const duration = dep.startedAt && dep.completedAt
    ? `${Math.round((new Date(dep.completedAt) - new Date(dep.startedAt)) / 1000)}s`
    : '—';
  const statusColor = { success: 'var(--teal)', failed: 'var(--danger)', running: 'var(--amber)' }[dep.status] || 'var(--muted)';
  const statusIcon  = { success: '✓', failed: '✕', running: '⏳' }[dep.status] || '?';
  const failedStep  = dep.failedStep ? escapeHtml(dep.failedStep) : '—';

  return `
  <tr>
    <td style="font-size:12px;white-space:nowrap;">${escapeHtml(started)}</td>
    <td><span class="badge">${escapeHtml(dep.branch || 'main')}</span></td>
    <td><span style="color:${statusColor};font-weight:600;">${statusIcon} ${escapeHtml(dep.status)}</span></td>
    <td style="font-size:12px;color:${dep.failedStep ? 'var(--danger)' : 'var(--muted-2)'};">${failedStep}</td>
    <td style="font-size:12px;color:var(--muted);">${escapeHtml(duration)}</td>
    <td>
      <button class="btn btn-ghost btn-sm" onclick="openDeployLog('${escapeHtml(dep._id)}')">View Logs</button>
    </td>
  </tr>`;
}

// Open deploy history for a specific app (from app card / table row)
function openDeployHistoryForApp(rg, name) {
  _historyContext = { rg, name };
  showTab('logs');
  // Switch to deploy-history sub-tab
  setTimeout(() => {
    document.querySelectorAll('#logSubTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.subtab === 'deploy-history'));
    document.getElementById('subpanel-activity').style.display = 'none';
    document.getElementById('subpanel-deploy-history').style.display = '';
    // Pre-select the app in the selector
    const sel = document.getElementById('historyApp');
    if (sel) {
      for (const opt of sel.options) {
        try {
          const val = JSON.parse(opt.value);
          if (val.rg === rg && val.name === name) { sel.value = opt.value; break; }
        } catch { /* skip */ }
      }
    }
    loadDeployHistory();
  }, 50);
}

// ── Deploy Log Viewer ──────────────────────────────────────────────────────

async function openDeployLog(deploymentId) {
  _currentLogData = { logs: [], deployment: null };
  _currentLogFilter = 'all';

  document.getElementById('deployLogTitle').textContent = 'Loading…';
  document.getElementById('deployLogMeta').textContent  = '';
  document.getElementById('deployLogFailedStep').style.display = 'none';
  document.getElementById('deployLogTerminal').innerHTML = '<span style="color:var(--muted-2);">Loading…</span>';
  document.getElementById('deployLogModal').classList.add('open');

  try {
    const { deployment } = await apiFetch(`/api/azure/deploy-log/${encodeURIComponent(deploymentId)}`);
    _currentLogData = { logs: deployment.logs || [], deployment };

    const started  = deployment.startedAt ? new Date(deployment.startedAt).toLocaleString() : '—';
    const duration = deployment.startedAt && deployment.completedAt
      ? `${Math.round((new Date(deployment.completedAt) - new Date(deployment.startedAt)) / 1000)}s`
      : '—';

    const statusColor = { success: 'var(--teal)', failed: 'var(--danger)', running: 'var(--amber)' }[deployment.status] || 'var(--muted)';
    document.getElementById('deployLogTitle').textContent = `${deployment.appName} — Deployment Log`;
    document.getElementById('deployLogMeta').innerHTML =
      `<span style="color:${statusColor};font-weight:600;">${deployment.status}</span> · ` +
      `${escapeHtml(deployment.branch || 'main')} · ${escapeHtml(started)} · ${escapeHtml(duration)}`;

    if (deployment.failedStep) {
      const failEl = document.getElementById('deployLogFailedStep');
      failEl.innerHTML = `✕ Failed at step: <strong>${escapeHtml(deployment.failedStep)}</strong>` +
        (deployment.errorMessage ? `<br><span style="font-size:12px;opacity:.8;">${escapeHtml(deployment.errorMessage.slice(0, 300))}${deployment.errorMessage.length > 300 ? '…' : ''}</span>` : '');
      failEl.style.display = 'block';
    }

    renderDeployLogTerminal();
  } catch (err) {
    document.getElementById('deployLogTerminal').innerHTML = `<div class="line error">${escapeHtml(err.message)}</div>`;
  }
}

function setLogFilter(filter, btn) {
  _currentLogFilter = filter;
  document.querySelectorAll('.log-filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  renderDeployLogTerminal();
}

function renderDeployLogTerminal() {
  const term = document.getElementById('deployLogTerminal');
  const { logs, deployment } = _currentLogData;

  if (!logs || !logs.length) {
    term.innerHTML = '<span style="color:var(--muted-2);">No log entries recorded for this deployment.</span>';
    return;
  }

  const filtered = _currentLogFilter === 'all'
    ? logs
    : _currentLogFilter === 'error'
      ? logs.filter((e) => e.level === 'error' || e.stream === 'error')
      : logs.filter((e) => e.stream === _currentLogFilter);

  const lines = filtered.map((entry) => {
    const ts    = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    const cls   = entry.stream === 'stderr' || entry.level === 'error' ? 'error'
                : entry.stream === 'stdout' ? 'info'
                : entry.level === 'warn'    ? 'warn'
                : entry.level === 'success' ? 'success'
                : 'info';
    const streamLabel = entry.stream && entry.stream !== 'info'
      ? `<span style="opacity:.5;font-size:.8em;margin-right:4px;">[${entry.stream}]</span>`
      : '';
    const stepLabel = entry.step
      ? `<span style="opacity:.4;font-size:.8em;margin-right:4px;">[${entry.step}]</span>`
      : '';
    const msg = escapeHtml(entry.message || '').replace(/\n/g, '<br>');
    return `<div class="line ${cls}"><span class="ts">${escapeHtml(ts)}</span>${stepLabel}${streamLabel}${msg}</div>`;
  });

  if (!lines.length) {
    term.innerHTML = `<span style="color:var(--muted-2);">No entries matching filter "${_currentLogFilter}".</span>`;
    return;
  }

  // Append Kudu log if available and showing all/error
  if (deployment?.kuduLog && (_currentLogFilter === 'all' || _currentLogFilter === 'error' || _currentLogFilter === 'stderr')) {
    lines.push('<div class="line" style="border-top:1px solid rgba(255,255,255,.1);margin:8px 0;padding:0;"></div>');
    lines.push('<div class="line warn">— Kudu Deployment Log —</div>');
    escapeHtml(deployment.kuduLog).split('\n').forEach((l) => {
      lines.push(`<div class="line error" style="padding-left:16px;">${l}</div>`);
    });
  }

  term.innerHTML = lines.join('');
  term.scrollTop = 0;
}

// ── Domains ────────────────────────────────────────────────────────────────

async function loadDomains() {
  const sel = document.getElementById('domainsApp');
  const val = sel.value;
  if (!val) { showToast('Select an app first', 'error'); return; }
  const { rg, name } = JSON.parse(val);
  currentDomainsApp = { rg, name };

  const panel = document.getElementById('domainsPanel');
  panel.innerHTML = '<div class="azure-loading"><div class="spinner"></div>Loading…</div>';

  try {
    const { domains } = await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/domains`);
    panel.innerHTML = `
      <div class="card">
        <div class="domains-list" id="domainsList">${domains.map(domainRow).join('')}</div>
        <div class="domain-add-row" style="margin-top:16px;">
          <input id="newDomainInput" placeholder="custom-domain.example.com" />
          <button class="btn btn-primary btn-sm" onclick="addDomain()">Add Domain</button>
        </div>
      </div>`;
  } catch (err) {
    panel.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

function domainRow(d) {
  const hostname = d.name || '';
  const isDefault = hostname.endsWith('.azurewebsites.net');
  return `
  <div class="domain-row">
    <span style="font-family:var(--font-mono);font-size:12.5px;">${escapeHtml(hostname)}</span>
    ${isDefault ? '<span class="badge">Default</span>' : ''}
    ${!isDefault ? `<button class="btn btn-danger btn-sm remove-domain" onclick="removeDomainEntry('${escapeHtml(hostname)}')">Remove</button>` : ''}
  </div>`;
}

async function addDomain() {
  const hostname = document.getElementById('newDomainInput').value.trim();
  if (!hostname) return;
  try {
    await apiFetch(`/api/azure/apps/${encodeURIComponent(currentDomainsApp.rg)}/${encodeURIComponent(currentDomainsApp.name)}/domains`, {
      method: 'POST', body: JSON.stringify({ hostname }),
    });
    showToast('Domain added', 'success');
    loadDomains();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function removeDomainEntry(hostname) {
  if (!confirm(`Remove domain "${hostname}"?`)) return;
  try {
    await apiFetch(`/api/azure/apps/${encodeURIComponent(currentDomainsApp.rg)}/${encodeURIComponent(currentDomainsApp.name)}/domains/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
    showToast('Domain removed', 'success');
    loadDomains();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Cost ───────────────────────────────────────────────────────────────────

async function loadCost() {
  const panel = document.getElementById('costPanel');
  panel.innerHTML = '<div class="azure-loading"><div class="spinner"></div>Fetching cost data…</div>';
  try {
    const { cost } = await apiFetch('/api/azure/cost');
    if (!cost || !cost.properties) {
      panel.innerHTML = '<div class="empty"><p>Cost data is not available. Ensure Cost Management is enabled on your subscription.</p></div>';
      return;
    }
    const rows   = cost.properties.rows || [];
    const cols   = cost.properties.columns || [];
    const costIdx = cols.findIndex((c) => c.name === 'Cost' || c.type === 'Number');
    const typeIdx = cols.findIndex((c) => c.name === 'ResourceType');

    const items = rows
      .map((r) => ({ type: r[typeIdx] || 'Other', cost: parseFloat(r[costIdx]) || 0 }))
      .filter((i) => i.cost > 0)
      .sort((a, b) => b.cost - a.cost);

    const total = items.reduce((s, i) => s + i.cost, 0);

    panel.innerHTML = `
      <div class="cost-summary">
        <div class="cost-card">
          <div class="cost-label">Estimated Monthly Cost</div>
          <div class="cost-value">$${total.toFixed(2)}</div>
          <div class="cost-currency">USD — current billing period</div>
        </div>
        <div class="cost-card">
          <div class="cost-label">Resource Types</div>
          <div class="cost-value">${items.length}</div>
          <div class="cost-currency">unique resource types</div>
        </div>
      </div>
      <div class="card">
        <div class="cost-breakdown">
          <div class="cost-breakdown-title">Resources by Cost</div>
          ${items.slice(0, 15).map((i) => {
            const pct = total > 0 ? (i.cost / total) * 100 : 0;
            const shortType = i.type.split('/').pop() || i.type;
            return `
            <div class="cost-row">
              <div class="cost-row-name">${escapeHtml(shortType)}</div>
              <div class="cost-row-bar-wrap"><div class="cost-row-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
              <div class="cost-row-amount">$${i.cost.toFixed(2)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  } catch (err) {
    panel.innerHTML = `<div class="empty"><p style="color:var(--danger);">${escapeHtml(err.message)}</p></div>`;
  }
}

// ── Credentials (Settings tab) ─────────────────────────────────────────────

document.getElementById('saveCredsBtn').addEventListener('click', async () => {
  const clientId       = document.getElementById('inputClientId').value.trim();
  const clientSecret   = document.getElementById('inputClientSecret').value.trim();
  const tenantId       = document.getElementById('inputTenantId').value.trim();
  const subscriptionId = document.getElementById('inputSubscriptionId').value.trim();

  const resultEl = document.getElementById('credsResult');
  resultEl.style.display = 'none';

  if (!clientId || !clientSecret || !tenantId || !subscriptionId) {
    showToast('All four fields are required', 'error');
    return;
  }

  try {
    await apiFetch('/api/azure/credentials', {
      method: 'POST',
      body: JSON.stringify({ clientId, clientSecret, tenantId, subscriptionId }),
    });
    resultEl.innerHTML = '<div class="creds-success">✓ Azure credentials saved and verified successfully. Reloading…</div>';
    resultEl.style.display = 'block';
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    resultEl.innerHTML = `<div class="creds-error">✗ ${escapeHtml(err.message)}</div>`;
    resultEl.style.display = 'block';
  }
});

document.getElementById('testCredsBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('credsResult');
  resultEl.innerHTML = '<div class="creds-success" style="color:var(--muted);">Testing connection…</div>';
  resultEl.style.display = 'block';
  try {
    const r = await apiFetch('/api/azure/credentials/verify', { method: 'POST' });
    if (r.ok) {
      resultEl.innerHTML = '<div class="creds-success">✓ Connection successful</div>';
    } else {
      resultEl.innerHTML = `<div class="creds-error">✗ ${escapeHtml(r.error || 'Connection failed')}</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="creds-error">✗ ${escapeHtml(err.message)}</div>`;
  }
});

document.getElementById('deleteCredsBtn').addEventListener('click', async () => {
  if (!confirm('Disconnect Azure? Your credential data will be erased.')) return;
  try {
    await apiFetch('/api/azure/credentials', { method: 'DELETE' });
    showToast('Azure disconnected', 'success');
    setTimeout(() => window.location.reload(), 800);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('refreshRegionsBtnSettings').addEventListener('click', () => {
  _regionsCache = null;
  loadRegions(true);
});

// ── SSE streaming helpers ──────────────────────────────────────────────────

/**
 * Parse Server-Sent Events from a raw string chunk.
 * Calls onEvent(type, parsedData) for each complete event.
 */
function parseSSEChunk(raw, onEvent) {
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    let data  = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:'))  data  = line.slice(5).trim();
    }
    if (!data) continue;
    try {
      onEvent(event, JSON.parse(data));
    } catch { /* malformed JSON — skip */ }
  }
}

// ── Deploy Modal ───────────────────────────────────────────────────────────

// Pipeline step order for the progress bar
const PIPELINE_STEPS = [
  'Clone Repository',
  'Install Dependencies',
  'Build',
  'Create Package',
  'Get Publishing Profile',
  'Configure Azure Settings',
  'Upload (Zip Deploy)',
  'Deployment Status',
  'Verify Deployed Files',
  'Application Startup',
];

let _dmCurrentDeploymentId = null;   // azureDeploymentId from server, set on success/error

function resetDeployModal() {
  document.getElementById('dm-form').style.display = '';
  document.getElementById('dm-log-screen').style.display = 'none';
  document.getElementById('dm-terminal').innerHTML = '';
  document.getElementById('dm-result').style.display = 'none';
  document.getElementById('dm-result').innerHTML = '';
  document.getElementById('dm-post-actions').style.display = 'none';
  document.getElementById('dm-step-progress').innerHTML = '';
  document.getElementById('dm-terminal-spinner').style.display = '';
  document.getElementById('deployModalTitle').textContent = 'Deploy to Azure App Service';
  _dmCurrentDeploymentId = null;

  const btn = document.getElementById('confirmDeployBtn');
  btn.disabled    = false;
  btn.textContent = '🚀 Deploy';
}

function renderStepProgress(currentStep, failedStep) {
  const container = document.getElementById('dm-step-progress');
  container.innerHTML = PIPELINE_STEPS.map((step) => {
    let cls = 'step-idle';
    let icon = '○';
    if (step === failedStep) { cls = 'step-failed'; icon = '✕'; }
    else if (step === currentStep) { cls = 'step-active'; icon = '●'; }
    else if (currentStep && PIPELINE_STEPS.indexOf(step) < PIPELINE_STEPS.indexOf(currentStep)) {
      cls = 'step-done'; icon = '✓';
    }
    return `<div class="deploy-step ${cls}">${icon} <span>${escapeHtml(step)}</span></div>`;
  }).join('');
}

function appendTerminalLine(entry) {
  const term = document.getElementById('dm-terminal');
  const cls  = entry.stream === 'stderr' || entry.level === 'error' ? 'error'
             : entry.stream === 'stdout' ? 'info'
             : entry.level === 'warn'    ? 'warn'
             : 'info';
  const streamLabel = entry.stream && entry.stream !== 'info'
    ? `<span style="opacity:.4;font-size:.8em;margin-right:4px;">[${entry.stream}]</span>`
    : '';
  const msg = escapeHtml(entry.message || '').replace(/\n/g, '<br>');
  const div = document.createElement('div');
  div.className = `line ${cls}`;
  div.innerHTML = `${streamLabel}${msg}`;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
}

function openDeployModal() {
  resetDeployModal();
  populateRgDropdown('dm-rg');
  loadRegions();
  document.getElementById('deployModal').classList.add('open');
}

document.getElementById('deployBtn').addEventListener('click', openDeployModal);
const deployFirstBtn = document.getElementById('deployFirstBtn');
if (deployFirstBtn) deployFirstBtn.addEventListener('click', openDeployModal);

// Auto-fill deploy modal from fireboxdeploy.toml
document.getElementById('dm-repo').addEventListener('blur', async () => {
  const repoUrl = document.getElementById('dm-repo').value.trim();
  const branch  = document.getElementById('dm-branch').value.trim() || 'main';
  if (!repoUrl) return;
  try {
    const { config } = await apiFetch(`/api/azure/toml-detect?repo=${encodeURIComponent(repoUrl)}&branch=${encodeURIComponent(branch)}`);
    if (!config) return;
    if (config.name  && !document.getElementById('dm-name').value)    document.getElementById('dm-name').value  = config.name;
    if (config.buildCommand)  document.getElementById('dm-build').value = config.buildCommand;
    if (config.startCommand)  document.getElementById('dm-start').value = config.startCommand;
    if (config.branch)        document.getElementById('dm-branch').value = config.branch;
    if (config.region) {
      const regionSel = document.getElementById('dm-region');
      if ([...regionSel.options].some((o) => o.value === config.region)) regionSel.value = config.region;
    }
    if (config.planSku) {
      const skuSel = document.getElementById('dm-sku');
      if ([...skuSel.options].some((o) => o.value === config.planSku)) skuSel.value = config.planSku;
    }
    if (config.runtimeStack) {
      const rtSel = document.getElementById('dm-runtime');
      if ([...rtSel.options].some((o) => o.value === config.runtimeStack)) rtSel.value = config.runtimeStack;
    }
    showToast('Auto-filled from fireboxdeploy.toml', 'success');
  } catch { /* ignore */ }
});

document.getElementById('confirmDeployBtn').addEventListener('click', async () => {
  const name    = document.getElementById('dm-name').value.trim();
  const rg      = document.getElementById('dm-rg').value;
  const region  = document.getElementById('dm-region').value;
  const runtime = document.getElementById('dm-runtime').value;
  const sku     = document.getElementById('dm-sku').value;
  const repoUrl = document.getElementById('dm-repo').value.trim();
  const branch  = document.getElementById('dm-branch').value.trim() || 'main';
  const build   = document.getElementById('dm-build').value.trim();
  const start   = document.getElementById('dm-start').value.trim();

  if (!name || !rg) { showToast('App name and resource group are required', 'error'); return; }

  const btn = document.getElementById('confirmDeployBtn');
  btn.disabled    = true;
  btn.textContent = 'Setting up…';

  try {
    // Step 1: Create App Service Plan
    btn.textContent = 'Creating plan…';
    const planName = `${name}-plan`;
    await apiFetch('/api/azure/plans', {
      method: 'POST',
      body: JSON.stringify({ resourceGroup: rg, name: planName, location: region, sku }),
    });

    // Step 2: Find plan ID
    const { plans } = await apiFetch('/api/azure/plans');
    const plan   = plans.find((p) => p.name === planName);
    const planId = plan?.id || '';

    // Step 3: Create Web App
    btn.textContent = 'Creating web app…';
    await apiFetch('/api/azure/apps', {
      method: 'POST',
      body: JSON.stringify({ resourceGroup: rg, name, location: region, planId, runtimeStack: runtime }),
    });

    // Step 4: Track locally (pre-flight, before deploy)
    await apiFetch('/api/azure/tracked-apps', {
      method: 'POST',
      body: JSON.stringify({
        name, resourceGroup: rg, region,
        planName, planSku: sku,
        runtime: runtime.split('|')[0].toLowerCase(),
        repoUrl, branch,
        buildCommand: build, startCommand: start,
        azureUrl: `${name}.azurewebsites.net`,
      }),
    }).catch(() => {}); // non-fatal

    if (!repoUrl) {
      showToast('App created in Azure (no repo — skipping deploy)', 'success');
      closeModal('deployModal');
      resetDeployModal();
      loadTrackedApps();
      loadLiveApps();
      return;
    }

    // Step 5: Switch modal to log screen and stream the deployment
    document.getElementById('dm-form').style.display = 'none';
    document.getElementById('dm-log-screen').style.display = '';
    document.getElementById('deployModalTitle').textContent = `Deploying ${name}…`;
    renderStepProgress('', '');

    let lastStep = '';

    const response = await fetch(
      `/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/deploy-stream`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ repoUrl, branch, buildCommand: build, startCommand: start }),
        credentials: 'same-origin',
      }
    );

    if (!response.ok) {
      throw new Error(`Deploy stream failed: HTTP ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE blocks (end with \n\n)
      const splitAt = buffer.lastIndexOf('\n\n');
      if (splitAt === -1) continue;
      const ready = buffer.slice(0, splitAt + 2);
      buffer = buffer.slice(splitAt + 2);

      parseSSEChunk(ready, (event, data) => {
        if (event === 'log') {
          appendTerminalLine(data);
        } else if (event === 'step') {
          lastStep = data.step;
          renderStepProgress(lastStep, '');
        } else if (event === 'success') {
          _dmCurrentDeploymentId = data.azureDeploymentId;
          document.getElementById('dm-terminal-spinner').style.display = 'none';
          // Mark all steps done
          renderStepProgress('__done__', '');
          const resultEl = document.getElementById('dm-result');
          resultEl.innerHTML = `
            <div style="padding:12px 14px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);border-radius:6px;">
              <div style="color:#4ade80;font-weight:600;margin-bottom:4px;">✓ Deployment successful!</div>
              ${data.url ? `<a href="${escapeHtml(data.url)}" target="_blank" rel="noopener" style="color:var(--azure);font-size:13px;">${escapeHtml(data.url)}</a>` : ''}
            </div>`;
          resultEl.style.display = 'block';
          document.getElementById('dm-post-actions').style.display = 'flex';
          document.getElementById('deployModalTitle').textContent = `✓ ${name} deployed`;
          loadTrackedApps();
          loadLiveApps();
        } else if (event === 'error') {
          _dmCurrentDeploymentId = data.azureDeploymentId;
          document.getElementById('dm-terminal-spinner').style.display = 'none';
          if (data.failedStep) renderStepProgress(data.failedStep, data.failedStep);

          const resultEl = document.getElementById('dm-result');
          const failedStepHtml = data.failedStep
            ? `<div style="font-size:12px;margin-top:4px;">Failed at step: <strong>${escapeHtml(data.failedStep)}</strong></div>`
            : '';
          resultEl.innerHTML = `
            <div style="padding:12px 14px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:6px;">
              <div style="color:#f87171;font-weight:600;margin-bottom:4px;">✕ Deployment failed</div>
              ${failedStepHtml}
              <div style="font-size:12px;margin-top:6px;color:var(--muted);white-space:pre-wrap;max-height:120px;overflow-y:auto;">${escapeHtml((data.message || '').slice(0, 600))}${(data.message || '').length > 600 ? '…' : ''}</div>
            </div>`;
          resultEl.style.display = 'block';
          document.getElementById('dm-post-actions').style.display = 'flex';
          document.getElementById('deployModalTitle').textContent = `✕ ${name} failed`;
          loadTrackedApps();
        }
      });
    }

    // Handle any remaining buffer
    if (buffer.trim()) {
      parseSSEChunk(buffer + '\n\n', (event, data) => {
        if (event === 'log')     appendTerminalLine(data);
        if (event === 'success') document.getElementById('dm-terminal-spinner').style.display = 'none';
        if (event === 'error')   document.getElementById('dm-terminal-spinner').style.display = 'none';
      });
    }

  } catch (err) {
    // Handle region/policy errors gracefully
    const isRegionError = /location|region|not available|policy|GeoPairWith|availability zone/i.test(err.message || '');
    if (isRegionError) {
      _regionsCache = null;
      await loadRegions(true);
      // Show on form screen if we haven't switched yet
      if (document.getElementById('dm-form').style.display !== 'none') {
        showToast(`Region rejected — dropdown refreshed. Select another and retry. (${err.message})`, 'error');
      } else {
        document.getElementById('dm-terminal-spinner').style.display = 'none';
        const resultEl = document.getElementById('dm-result');
        resultEl.innerHTML = `<div style="padding:12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:6px;color:#f87171;">${escapeHtml(err.message)}</div>`;
        resultEl.style.display = 'block';
        document.getElementById('dm-post-actions').style.display = 'flex';
      }
    } else {
      if (document.getElementById('dm-log-screen').style.display !== 'none') {
        document.getElementById('dm-terminal-spinner').style.display = 'none';
        const resultEl = document.getElementById('dm-result');
        resultEl.innerHTML = `<div style="padding:12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:6px;color:#f87171;">${escapeHtml(err.message)}</div>`;
        resultEl.style.display = 'block';
        document.getElementById('dm-post-actions').style.display = 'flex';
      } else {
        showToast(err.message, 'error');
        btn.disabled    = false;
        btn.textContent = '🚀 Deploy';
      }
    }
  }
});

// "View Deployment Logs" post-deploy button
document.getElementById('dm-view-logs-btn').addEventListener('click', () => {
  if (_dmCurrentDeploymentId) {
    openDeployLog(_dmCurrentDeploymentId);
  } else {
    showToast('No deployment ID available yet', 'error');
  }
});

// ── New Resource Group Modal ───────────────────────────────────────────────

document.getElementById('newRgBtn').addEventListener('click', () => {
  document.getElementById('newRgModal').classList.add('open');
});

document.getElementById('confirmNewRgBtn').addEventListener('click', async () => {
  const name     = document.getElementById('rg-name').value.trim();
  const location = document.getElementById('rg-location').value;
  if (!name) { showToast('Name is required', 'error'); return; }
  try {
    await apiFetch('/api/azure/resource-groups', {
      method: 'POST',
      body: JSON.stringify({ name, location }),
    });
    showToast('Resource group created', 'success');
    closeModal('newRgModal');
    loadResourceGroups();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── App Detail Modal ───────────────────────────────────────────────────────

async function openAppDetail(rg, name, trackedId) {
  document.getElementById('appDetailTitle').textContent = name;
  document.getElementById('appDetailBody').innerHTML = '<div class="azure-loading"><div class="spinner"></div>Loading…</div>';
  document.getElementById('appDetailModal').classList.add('open');

  try {
    const { app } = await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}`);
    const props = app.properties || {};
    const url   = props.defaultHostName ? `https://${props.defaultHostName}` : '';
    const state = props.state || '—';

    document.getElementById('appDetailBody').innerHTML = `
      <div class="app-detail-row"><div class="app-detail-label">URL</div><div class="app-detail-value">${url ? `<a href="${escapeHtml(url)}" target="_blank" style="color:var(--azure);">${escapeHtml(url)}</a>` : '—'}</div></div>
      <div class="app-detail-row"><div class="app-detail-label">Runtime</div><div class="app-detail-value">${escapeHtml(props.siteConfig?.linuxFxVersion || '—')}</div></div>
      <div class="app-detail-row"><div class="app-detail-label">Status</div><div class="app-detail-value" style="color:${state === 'Running' ? 'var(--teal)' : 'var(--muted)'};">${escapeHtml(state)}</div></div>
      <div class="app-detail-row"><div class="app-detail-label">Region</div><div class="app-detail-value">${escapeHtml(app.location || '—')}</div></div>
      <div class="app-detail-row"><div class="app-detail-label">Created</div><div class="app-detail-value">${props.createdTime ? new Date(props.createdTime).toLocaleString() : '—'}</div></div>
      <div class="app-detail-row"><div class="app-detail-label">HTTPS Only</div><div class="app-detail-value">${props.httpsOnly ? '✓ Yes' : 'No'}</div></div>
      <div class="app-detail-actions">
        <button class="btn btn-primary btn-sm" onclick="appAction('restart','${escapeHtml(rg)}','${escapeHtml(name)}');closeModal('appDetailModal');">↻ Restart</button>
        <button class="btn btn-ghost btn-sm"   onclick="appAction('start','${escapeHtml(rg)}','${escapeHtml(name)}')">▶ Start</button>
        <button class="btn btn-ghost btn-sm"   onclick="appAction('stop','${escapeHtml(rg)}','${escapeHtml(name)}')">■ Stop</button>
        <button class="btn btn-ghost btn-sm"   onclick="closeModal('appDetailModal');showTab('env-vars');setEnvVarsApp('${escapeHtml(rg)}','${escapeHtml(name)}')">⚙ Env Vars</button>
        <button class="btn btn-ghost btn-sm"   onclick="closeModal('appDetailModal');openScaleModal('${escapeHtml(rg)}','${escapeHtml(app.name || name)}')">⇅ Scale</button>
        <button class="btn btn-ghost btn-sm"   onclick="closeModal('appDetailModal');openDeployHistoryForApp('${escapeHtml(rg)}','${escapeHtml(name)}')">📋 Deploy Logs</button>
        <button class="btn btn-danger btn-sm"  onclick="confirmDeleteApp('${escapeHtml(rg)}','${escapeHtml(name)}');closeModal('appDetailModal');">🗑 Delete</button>
      </div>`;
  } catch {
    document.getElementById('appDetailBody').innerHTML = `
      <p style="color:var(--muted);">This app is tracked locally. It may not exist yet in Azure, or you may need to deploy it first.</p>
      <div class="app-detail-actions">
        <button class="btn btn-ghost btn-sm" onclick="closeModal('appDetailModal');openDeployHistoryForApp('${escapeHtml(rg)}','${escapeHtml(trackedId)}')">📋 Deploy Logs</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTrackedApp('${escapeHtml(trackedId)}')">Remove from Firebox</button>
      </div>`;
  }
}

async function deleteTrackedApp(id) {
  if (!confirm('Remove this app from FireboxDeploy? The Azure resource will NOT be deleted.')) return;
  try {
    await apiFetch(`/api/azure/tracked-apps/${id}`, { method: 'DELETE' });
    showToast('App removed', 'success');
    closeModal('appDetailModal');
    loadTrackedApps();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function parseAzureId(id) {
  const rgMatch   = id.match(/resourceGroups\/([^/]+)/i);
  const nameMatch = id.match(/sites\/([^/]+)$/i);
  return [rgMatch?.[1] || '', nameMatch?.[1] || ''];
}

async function populateAppSelectors() {
  if (!azureConfigured) return;
  try {
    const { apps } = await apiFetch('/api/azure/apps');
    allLiveApps = apps || [];
    const options = apps.map((a) => {
      const [rg, name] = parseAzureId(a.id || '');
      return `<option value='${JSON.stringify({ rg, name })}'>${escapeHtml(a.name)}</option>`;
    }).join('');
    ['monitorApp', 'logsApp', 'domainsApp', 'envVarsApp', 'historyApp'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">Select app…</option>${options}`;
    });
  } catch { /* ignore */ }
}

async function populateRgDropdown(selectId) {
  const sel = document.getElementById(selectId);
  try {
    const { resourceGroups } = await apiFetch('/api/azure/resource-groups');
    sel.innerHTML = resourceGroups.map((rg) => `<option value="${escapeHtml(rg.name)}">${escapeHtml(rg.name)} (${escapeHtml(rg.location)})</option>`).join('');
    if (!resourceGroups.length) sel.innerHTML = '<option value="">No resource groups — create one first</option>';
  } catch {
    sel.innerHTML = '<option value="">Error loading resource groups</option>';
  }
}

// Close modals on backdrop click
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('open');
      if (overlay.id === 'deployModal') resetDeployModal();
    }
  });
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('firebox_token');
  window.location.href = '/login';
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadOverview();
  populateAppSelectors();
});

// Boot
init();
