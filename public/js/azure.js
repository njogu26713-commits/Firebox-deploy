/**
 * azure.js — FireboxDeploy Azure dashboard frontend
 */

// ── State ──────────────────────────────────────────────────────────────────
let azureConfigured = false;
let allLiveApps = [];
let allResourceGroups = [];
let currentDomainsApp = { rg: '', name: '' };
let _regionsCache = null; // [{ name, displayName }] — client-side cache to avoid redundant API calls

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
    // Hide the full-page overlay; show a compact notice inside the settings panel instead
    document.getElementById('notConfiguredBanner').style.display = 'none';
    showTab('settings');
    // Inject a small notice at the top of the settings panel
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

/**
 * Fetch available regions for the connected subscription from the Azure Management
 * API and populate every region/location <select> in the UI.
 *
 * Uses a client-side cache so rapid modal opens don't re-fetch; pass force=true
 * (or click "Refresh Regions") to bypass both the client cache and the 30-min
 * server-side cache.
 */
async function loadRegions(force = false) {
  if (!azureConfigured) return;

  // Fast path: client already has data and caller didn't ask for a refresh
  if (!force && _regionsCache) {
    populateRegionSelects(_regionsCache);
    return;
  }

  // Show loading state in all region/location dropdowns
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
  // value = Azure location name (e.g. "eastus")
  // text  = friendly display name (e.g. "East US")
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
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));

  // Lazy-load on first open
  if (name === 'apps')             loadLiveApps();
  if (name === 'resource-groups')  loadResourceGroups();
  if (name === 'cost')             loadCost();
  if (name === 'env-vars' && !document.querySelector('#envVarRows')) loadEnvVars();
}

document.getElementById('azureTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) showTab(tab.dataset.tab);
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

  // cost tile
  apiFetch('/api/azure/cost').then((r) => {
    const rows = r.cost?.properties?.rows || [];
    const total = rows.reduce((sum, row) => sum + (parseFloat(row[0]) || 0), 0);
    document.getElementById('monthlyCost').textContent = `$${total.toFixed(2)}`;
  }).catch(() => { document.getElementById('monthlyCost').textContent = '—'; });

  // tracked apps
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
  const statusColor  = { running: 'var(--teal)', stopped: 'var(--muted)', failed: 'var(--danger)', building: 'var(--amber)', deploying: 'var(--amber)', idle: 'var(--muted-2)' };

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
  // Try to find and select the matching option
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
  // Look up the plan name from allLiveApps
  const app = allLiveApps.find((a) => a.name === appName);
  const planId = app?.properties?.serverFarmId || '';
  const planName = planId.split('/').pop() || `${appName}-plan`;
  _scaleContext = { rg, planName };

  document.getElementById('scalePlanName').textContent = planName;

  // Try to fetch current instance count
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

// ── Logs ───────────────────────────────────────────────────────────────────

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
      const status  = (props.status || 'unknown').toLowerCase();
      const author  = props.author || '';

      if (entry._type === 'activity') {
        // Azure Activity Log event (start/stop/restart/config/deploy operations)
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
        // Kudu deployment pipeline entry
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

// "Refresh Regions" button in Settings tab — useful after changing subscription
document.getElementById('refreshRegionsBtnSettings').addEventListener('click', () => {
  _regionsCache = null; // bust client cache
  loadRegions(true);    // bust server cache + repopulate all region dropdowns
});

// ── Deploy Modal ───────────────────────────────────────────────────────────

function openDeployModal() {
  populateRgDropdown('dm-rg');
  loadRegions(); // uses client cache if available; fetches from server only when needed
  document.getElementById('deployModal').classList.add('open');
}

document.getElementById('deployBtn').addEventListener('click', openDeployModal);
document.getElementById('deployFirstBtn') && document.getElementById('deployFirstBtn').addEventListener('click', openDeployModal);

// Auto-fill deploy modal from fireboxdeploy.toml when repo URL is entered
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
  } catch { /* file not found or not a GitHub repo — ignore */ }
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
  btn.disabled = true;
  btn.textContent = 'Deploying…';

  try {
    // 1. Create App Service Plan
    const planName = `${name}-plan`;
    await apiFetch('/api/azure/plans', {
      method: 'POST',
      body: JSON.stringify({ resourceGroup: rg, name: planName, location: region, sku }),
    });

    // 2. Determine plan ID
    const creds = await apiFetch('/api/azure/status');
    // Get plans to find the ID
    const { plans } = await apiFetch('/api/azure/plans');
    const plan = plans.find((p) => p.name === planName);
    const planId = plan?.id || '';

    // 3. Create Web App
    await apiFetch('/api/azure/apps', {
      method: 'POST',
      body: JSON.stringify({ resourceGroup: rg, name, location: region, planId, runtimeStack: runtime }),
    });

    // 4. Configure GitHub source
    if (repoUrl) {
      await apiFetch(`/api/azure/apps/${encodeURIComponent(rg)}/${encodeURIComponent(name)}/deploy`, {
        method: 'POST',
        body: JSON.stringify({ repoUrl, branch }),
      });
    }

    // 5. Track locally
    const [rgStr] = [rg];
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
    });

    showToast('App deployed to Azure!', 'success');
    closeModal('deployModal');
    loadTrackedApps();
    loadLiveApps();
  } catch (err) {
    // If Azure rejected the deployment because of a region restriction or policy,
    // automatically refresh the region list so the dropdown only shows valid regions.
    const isRegionError = /location|region|not available|policy|GeoPairWith|availability zone/i.test(err.message || '');
    if (isRegionError) {
      _regionsCache = null; // bust client cache
      await loadRegions(true); // force server cache bust + repopulate dropdowns
      showToast(
        `Region rejected by Azure — the dropdown has been refreshed with allowed regions. Please select another and try again. (${err.message})`,
        'error'
      );
    } else {
      showToast(err.message, 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Deploy';
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
        <button class="btn btn-danger btn-sm"  onclick="confirmDeleteApp('${escapeHtml(rg)}','${escapeHtml(name)}');closeModal('appDetailModal');">🗑 Delete</button>
      </div>`;
  } catch {
    // Fallback for apps only tracked locally
    document.getElementById('appDetailBody').innerHTML = `
      <p style="color:var(--muted);">This app is tracked locally. It may not exist yet in Azure, or you may need to deploy it first.</p>
      <div class="app-detail-actions">
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
  // /subscriptions/{sub}/resourceGroups/{rg}/providers/.../sites/{name}
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
    ['monitorApp', 'logsApp', 'domainsApp', 'envVarsApp'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">Select app…</option>${options}`;
    });
  } catch { /* ignore — user can still type */ }
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
    if (e.target === overlay) overlay.classList.remove('open');
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
