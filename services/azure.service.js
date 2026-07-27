/**
 * azure.service.js
 * Core Azure REST API integration for FireboxDeploy.
 *
 * Handles: authentication, token management, resource groups,
 * App Services, monitoring, logs, scaling, domains, cost management,
 * and deployment from GitHub.
 */

const crypto = require('crypto');
const axios  = require('axios');
const AzureProvider = require('../models/AzureProvider');

// ── Encryption helpers ─────────────────────────────────────────────────────
// Key: 32-byte SHA-256 derived from SESSION_SECRET

function _key() {
  const secret = process.env.SESSION_SECRET || 'firebox_dev_secret_change_me';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return '';
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv:  iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decrypt(stored) {
  if (!stored) return '';
  try {
    const { iv, tag, data } = JSON.parse(stored);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return decipher.update(Buffer.from(data, 'base64')) + decipher.final('utf8');
  } catch {
    return '';
  }
}

// ── Provider singleton ─────────────────────────────────────────────────────

async function getProvider() {
  return AzureProvider.findOne();
}

async function saveCredentials({ clientId, clientSecret, tenantId, subscriptionId }) {
  const doc = (await AzureProvider.findOne()) || new AzureProvider();
  doc.clientId       = encrypt(clientId);
  doc.clientSecret   = encrypt(clientSecret);
  doc.tenantId       = encrypt(tenantId);
  doc.subscriptionId = encrypt(subscriptionId);
  doc.cachedToken    = '';
  doc.tokenExpiresAt = null;
  doc.status         = 'unconfigured';
  doc.statusError    = '';
  await doc.save();
  return doc;
}

async function getDecryptedCredentials() {
  const doc = await getProvider();
  if (!doc || !doc.clientId) return null;
  return {
    clientId:       decrypt(doc.clientId),
    clientSecret:   decrypt(doc.clientSecret),
    tenantId:       decrypt(doc.tenantId),
    subscriptionId: decrypt(doc.subscriptionId),
  };
}

// ── Token management ───────────────────────────────────────────────────────

async function getToken() {
  const doc = await getProvider();
  if (!doc || !doc.clientId) throw new Error('Azure credentials not configured');

  // Return cached token if still valid (1 min buffer)
  if (doc.cachedToken && doc.tokenExpiresAt && doc.tokenExpiresAt > new Date(Date.now() + 60_000)) {
    return decrypt(doc.cachedToken);
  }

  const creds = await getDecryptedCredentials();
  if (!creds || !creds.tenantId) throw new Error('Azure credentials are incomplete');

  try {
    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     creds.clientId,
      client_secret: creds.clientSecret,
      scope:         'https://management.azure.com/.default',
    });
    const res = await axios.post(
      `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, expires_in } = res.data;
    doc.cachedToken    = encrypt(access_token);
    doc.tokenExpiresAt = new Date(Date.now() + expires_in * 1000);
    doc.status         = 'connected';
    doc.statusError    = '';
    doc.lastVerified   = new Date();
    await doc.save();
    return access_token;
  } catch (err) {
    doc.status      = 'failed';
    doc.statusError = err.response?.data?.error_description || err.message;
    await doc.save();
    throw new Error(`Azure auth failed: ${doc.statusError}`);
  }
}

// ── Core HTTP helper ───────────────────────────────────────────────────────

function extractAzureError(err) {
  // Azure REST errors nest the human-readable message inside err.response.data.error
  const body = err.response?.data;
  if (body?.error?.message) return body.error.message;
  if (body?.error?.code)    return `Azure error: ${body.error.code}`;
  if (body?.message)        return body.message;
  return err.message;
}

async function azureRequest(method, url, data = null, extraHeaders = {}) {
  const token = await getToken();
  const config = {
    method,
    url,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
  };
  if (data !== null) config.data = data;
  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    const msg = extractAzureError(err);
    const status = err.response?.status;
    const wrapped = new Error(msg);
    wrapped.azureStatus = status;
    throw wrapped;
  }
}

function managementUrl(path) {
  return `https://management.azure.com${path}`;
}

// ── Subscription ───────────────────────────────────────────────────────────

async function getSubscription() {
  const creds = await getDecryptedCredentials();
  return azureRequest('GET', managementUrl(`/subscriptions/${creds.subscriptionId}?api-version=2022-12-01`));
}

// ── Locations (Regions) ────────────────────────────────────────────────────
// Cache is keyed by subscriptionId so swapping subscriptions always fetches fresh.

const _locationCache = new Map(); // key: subscriptionId → { data, expiresAt }
const LOCATION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function listLocations() {
  const creds = await getDecryptedCredentials();
  if (!creds) throw new Error('Azure credentials not configured');
  const subId = creds.subscriptionId;

  const cached = _locationCache.get(subId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${subId}/locations?api-version=2022-12-01`)
  );

  // Filter out Edge Zones / Arc Zones — only proper regions are deployable
  const locations = (res.value || [])
    .filter((loc) => loc.metadata?.regionType === 'Physical' || (!loc.type || loc.type === 'Region'))
    .filter((loc) => loc.type !== 'EdgeZone' && loc.type !== 'ArcZone')
    .map((loc) => ({ name: loc.name, displayName: loc.displayName || loc.name }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  _locationCache.set(subId, { data: locations, expiresAt: Date.now() + LOCATION_CACHE_TTL_MS });
  return locations;
}

function clearLocationCache() {
  _locationCache.clear();
}

// ── Dashboard summary ──────────────────────────────────────────────────────

async function getDashboardSummary() {
  const creds = await getDecryptedCredentials();
  const subId = creds.subscriptionId;

  const [sub, rgs, apps, vms, storage] = await Promise.allSettled([
    azureRequest('GET', managementUrl(`/subscriptions/${subId}?api-version=2022-12-01`)),
    azureRequest('GET', managementUrl(`/subscriptions/${subId}/resourcegroups?api-version=2021-04-01`)),
    azureRequest('GET', managementUrl(`/subscriptions/${subId}/providers/Microsoft.Web/sites?api-version=2022-03-01`)),
    azureRequest('GET', managementUrl(`/subscriptions/${subId}/providers/Microsoft.Compute/virtualMachines?api-version=2023-03-01`)),
    azureRequest('GET', managementUrl(`/subscriptions/${subId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`)),
  ]);

  return {
    subscription:   sub.status === 'fulfilled'     ? sub.value     : null,
    resourceGroups: rgs.status === 'fulfilled'     ? rgs.value.value : [],
    apps:           apps.status === 'fulfilled'    ? apps.value.value : [],
    vms:            vms.status === 'fulfilled'     ? vms.value.value  : [],
    storageAccounts: storage.status === 'fulfilled' ? storage.value.value : [],
  };
}

// ── Resource Groups ────────────────────────────────────────────────────────

async function listResourceGroups() {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourcegroups?api-version=2021-04-01`)
  );
  return res.value || [];
}

async function createResourceGroup(name, location = 'eastus', tags = {}) {
  const creds = await getDecryptedCredentials();
  return azureRequest('PUT',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(name)}?api-version=2021-04-01`),
    { location, tags }
  );
}

async function deleteResourceGroup(name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('DELETE',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(name)}?api-version=2021-04-01`)
  );
}

// ── App Service Plans ──────────────────────────────────────────────────────

async function listAppServicePlans() {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/providers/Microsoft.Web/serverfarms?api-version=2022-03-01`)
  );
  return res.value || [];
}

async function createAppServicePlan(resourceGroup, name, location, sku = 'F1', isLinux = true) {
  const creds = await getDecryptedCredentials();
  return azureRequest('PUT',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/serverfarms/${encodeURIComponent(name)}?api-version=2022-03-01`),
    {
      location,
      sku:  { name: sku },
      kind: isLinux ? 'linux' : 'app',
      properties: { reserved: isLinux },
    }
  );
}

// ── Web Apps (App Service) ────────────────────────────────────────────────

async function listApps() {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/providers/Microsoft.Web/sites?api-version=2022-03-01`)
  );
  return res.value || [];
}

async function getApp(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}?api-version=2022-03-01`)
  );
}

async function createApp(resourceGroup, appName, location, planId, runtimeStack = 'NODE|18-lts') {
  const creds = await getDecryptedCredentials();
  return azureRequest('PUT',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}?api-version=2022-03-01`),
    {
      location,
      kind: 'app,linux',
      properties: {
        serverFarmId: planId,
        siteConfig: {
          linuxFxVersion: runtimeStack,
          alwaysOn:       false,
          http20Enabled:  true,
        },
        httpsOnly: true,
      },
    }
  );
}

async function deleteApp(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('DELETE',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}?api-version=2022-03-01`)
  );
}

async function startApp(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('POST',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/start?api-version=2022-03-01`)
  );
}

async function stopApp(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('POST',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/stop?api-version=2022-03-01`)
  );
}

async function restartApp(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('POST',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/restart?api-version=2022-03-01`)
  );
}

// ── App Settings (Env Vars) ────────────────────────────────────────────────

async function getAppSettings(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('POST',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/config/appsettings/list?api-version=2022-03-01`)
  );
  return res.properties || {};
}

async function updateAppSettings(resourceGroup, name, settings) {
  const creds = await getDecryptedCredentials();
  return azureRequest('PUT',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/config/appsettings?api-version=2022-03-01`),
    { properties: settings }
  );
}

// ── Source Control (Deploy from GitHub) ───────────────────────────────────

async function configureGithubDeploy(resourceGroup, name, repoUrl, branch = 'main') {
  const creds = await getDecryptedCredentials();
  return azureRequest('PUT',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/sourcecontrols/web?api-version=2022-03-01`),
    {
      properties: {
        repoUrl,
        branch,
        isManualIntegration: true,
        deploymentRollbackEnabled: true,
        isMercurial: false,
      },
    }
  );
}

async function syncDeploy(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  return azureRequest('POST',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/sync?api-version=2022-03-01`)
  );
}

async function listDeployments(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/deployments?api-version=2022-03-01`)
  );
  return res.value || [];
}

// ── Monitoring (Azure Monitor) ─────────────────────────────────────────────

const VALID_RANGES = {
  '1h':  { interval: 'PT1M',  start: () => new Date(Date.now() - 3600_000) },
  '24h': { interval: 'PT5M',  start: () => new Date(Date.now() - 86_400_000) },
  '7d':  { interval: 'PT1H',  start: () => new Date(Date.now() - 7 * 86_400_000) },
  '30d': { interval: 'PT6H',  start: () => new Date(Date.now() - 30 * 86_400_000) },
};

async function getMetrics(resourceGroup, appName, range = '24h') {
  const creds    = await getDecryptedCredentials();
  const subId    = creds.subscriptionId;
  const { interval, start } = VALID_RANGES[range] || VALID_RANGES['24h'];
  const startTime = start().toISOString();
  const endTime   = new Date().toISOString();

  const resourceId = `/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${appName}`;
  const metricNames = 'CpuTime,MemoryWorkingSet,BytesReceived,BytesSent,Requests,AverageResponseTime,Http5xx';

  const res = await azureRequest('GET',
    managementUrl(`${resourceId}/providers/microsoft.insights/metrics?api-version=2023-10-01&metricnames=${metricNames}&timespan=${startTime}/${endTime}&interval=${interval}&aggregation=Average,Total`)
  );
  return res.value || [];
}

// ── Logs ───────────────────────────────────────────────────────────────────

async function getRecentLogs(resourceGroup, appName) {
  const creds = await getDecryptedCredentials();
  const subId = creds.subscriptionId;

  // Resource ID for this App Service
  const resourceId = `/subscriptions/${subId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(appName)}`;

  // ── 1. Azure Activity Logs (always populated; shows starts, stops, restarts, config changes, deployments) ──
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // last 7 days
  const activityFilter = `eventTimestamp ge '${since}' and resourceUri eq '${resourceId}'`;
  const activityLogsPromise = azureRequest('GET',
    managementUrl(`/subscriptions/${subId}/providers/microsoft.insights/eventtypes/management/values?api-version=2015-04-01&$filter=${encodeURIComponent(activityFilter)}&$select=eventTimestamp,operationName,status,caller,description,level,properties`)
  ).catch(() => ({ value: [] }));

  // ── 2. Deployment history (Kudu pipeline; only present when deployed via Azure Deployment Center) ──
  const deploymentsPromise = azureRequest('GET',
    managementUrl(`${resourceId}/deployments?api-version=2022-03-01`)
  ).catch(() => ({ value: [] }));

  const [activityRes, deploymentsRes] = await Promise.all([activityLogsPromise, deploymentsPromise]);

  const activityEvents = (activityRes.value || []).map((ev) => ({
    _type: 'activity',
    id: ev.id,
    name: ev.operationName?.localizedValue || ev.operationName?.value || 'Operation',
    properties: {
      startTime:   ev.eventTimestamp,
      status:      ev.status?.localizedValue || ev.status?.value || 'unknown',
      author:      ev.caller || '',
      message:     ev.description || ev.operationName?.localizedValue || ev.operationName?.value || '',
      level:       ev.level || 'Informational',
    },
  }));

  const deployments = (deploymentsRes.value || []);
  const detailed = await Promise.allSettled(
    deployments.slice(0, 5).map(async (dep) => {
      if (!dep.name) return { ...dep, _type: 'deployment' };
      try {
        const logRes = await azureRequest('GET',
          managementUrl(`${resourceId}/deployments/${dep.name}/log?api-version=2022-03-01`)
        );
        return { ...dep, _type: 'deployment', logEntries: logRes.value || [] };
      } catch {
        return { ...dep, _type: 'deployment' };
      }
    })
  );
  const deploymentEvents = detailed.map((r) => r.status === 'fulfilled' ? r.value : r.reason);

  // Merge & sort newest-first
  const all = [...activityEvents, ...deploymentEvents].sort((a, b) => {
    const ta = new Date(a.properties?.startTime || 0).getTime();
    const tb = new Date(b.properties?.startTime || 0).getTime();
    return tb - ta;
  });

  return all;
}

async function getAppInstanceCount(resourceGroup, planName) {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/serverfarms/${encodeURIComponent(planName)}?api-version=2022-03-01`)
  );
  return res?.sku?.capacity ?? 1;
}

// ── Custom Domains ─────────────────────────────────────────────────────────

async function listHostNames(resourceGroup, name) {
  const creds = await getDecryptedCredentials();
  const res = await azureRequest('GET',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/hostNameBindings?api-version=2022-03-01`)
  );
  return res.value || [];
}

async function addCustomDomain(resourceGroup, name, hostname) {
  const creds = await getDecryptedCredentials();
  return azureRequest('PUT',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/hostNameBindings/${encodeURIComponent(hostname)}?api-version=2022-03-01`),
    { properties: { siteName: name, hostNameType: 'Verified', sslState: 'Disabled' } }
  );
}

async function removeCustomDomain(resourceGroup, name, hostname) {
  const creds = await getDecryptedCredentials();
  return azureRequest('DELETE',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/hostNameBindings/${encodeURIComponent(hostname)}?api-version=2022-03-01`)
  );
}

// ── Scaling ────────────────────────────────────────────────────────────────

async function scaleApp(resourceGroup, planName, instanceCount) {
  const creds = await getDecryptedCredentials();
  return azureRequest('PATCH',
    managementUrl(`/subscriptions/${creds.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/serverfarms/${encodeURIComponent(planName)}?api-version=2022-03-01`),
    { sku: { capacity: instanceCount } }
  );
}

// ── Cost Management ────────────────────────────────────────────────────────

async function getCostSummary() {
  const creds = await getDecryptedCredentials();
  const subId = creds.subscriptionId;
  const now   = new Date();
  const from  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to    = now.toISOString().slice(0, 10);
  const res = await azureRequest('POST',
    managementUrl(`/subscriptions/${subId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`),
    {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from, to },
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'ResourceType' }],
      },
    }
  );
  return res;
}

// ── Status check ───────────────────────────────────────────────────────────

async function verifyConnection() {
  try {
    await getToken();
    await getSubscription();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Runtime detection ──────────────────────────────────────────────────────

const RUNTIME_MAP = {
  'package.json':     { runtime: 'nodejs',  linuxFx: 'NODE|18-lts' },
  'requirements.txt': { runtime: 'python',  linuxFx: 'PYTHON|3.11' },
  'composer.json':    { runtime: 'php',     linuxFx: 'PHP|8.2' },
  'go.mod':           { runtime: 'go',      linuxFx: 'GO|1.21' },
  'Cargo.toml':       { runtime: 'dotnet',  linuxFx: 'DOTNETCORE|8.0' },
  'pom.xml':          { runtime: 'java',    linuxFx: 'JAVA|17-java17' },
};

function detectRuntime(fileList) {
  for (const [file, info] of Object.entries(RUNTIME_MAP)) {
    if (fileList.includes(file)) return info;
  }
  return { runtime: 'nodejs', linuxFx: 'NODE|18-lts' };
}

module.exports = {
  encrypt,
  decrypt,
  saveCredentials,
  getDecryptedCredentials,
  getProvider,
  getToken,
  verifyConnection,

  getSubscription,
  getDashboardSummary,
  listLocations,
  clearLocationCache,

  listResourceGroups,
  createResourceGroup,
  deleteResourceGroup,

  listAppServicePlans,
  createAppServicePlan,

  listApps,
  getApp,
  createApp,
  deleteApp,
  startApp,
  stopApp,
  restartApp,

  getAppSettings,
  updateAppSettings,

  configureGithubDeploy,
  syncDeploy,
  listDeployments,

  getMetrics,
  getRecentLogs,
  getAppInstanceCount,

  listHostNames,
  addCustomDomain,
  removeCustomDomain,

  scaleApp,
  getCostSummary,

  detectRuntime,
};
