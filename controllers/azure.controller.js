/**
 * azure.controller.js
 * Request handlers for all Azure API routes.
 */

const azure       = require('../services/azure.service');
const azureDeploy = require('../services/azure-deploy.service');
const AzureApp    = require('../models/AzureApp');
const User        = require('../models/User');
const cryptoSvc   = require('../services/crypto.service');
const tomlService = require('../services/fireboxdeploy-toml.service');

// ── Credentials & Status ───────────────────────────────────────────────────

async function getStatus(req, res) {
  const provider = await azure.getProvider();
  if (!provider || !provider.clientId) {
    return res.json({ status: 'unconfigured', configured: false });
  }
  return res.json({
    status:       provider.status,
    statusError:  provider.statusError,
    lastVerified: provider.lastVerified,
    configured:   true,
  });
}

async function saveCredentials(req, res) {
  const { clientId, clientSecret, tenantId, subscriptionId } = req.body;
  if (!clientId || !clientSecret || !tenantId || !subscriptionId) {
    return res.status(400).json({ error: 'All four Azure credentials are required' });
  }
  await azure.saveCredentials({ clientId, clientSecret, tenantId, subscriptionId });
  azure.clearLocationCache(); // subscription may have changed — force fresh region fetch
  // Attempt immediate verification
  const check = await azure.verifyConnection();
  if (!check.ok) {
    return res.status(400).json({ error: `Credentials saved but connection failed: ${check.error}` });
  }
  res.json({ success: true, message: 'Azure credentials saved and verified' });
}

async function verifyConnection(req, res) {
  const check = await azure.verifyConnection();
  res.json(check);
}

async function deleteCredentials(req, res) {
  const provider = await azure.getProvider();
  if (provider) {
    provider.clientId       = '';
    provider.clientSecret   = '';
    provider.tenantId       = '';
    provider.subscriptionId = '';
    provider.cachedToken    = '';
    provider.tokenExpiresAt = null;
    provider.status         = 'unconfigured';
    provider.statusError    = '';
    await provider.save();
  }
  res.json({ success: true });
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function getDashboard(req, res) {
  const summary = await azure.getDashboardSummary();
  res.json(summary);
}

// ── Locations (Regions) ────────────────────────────────────────────────────

async function listLocations(req, res) {
  // ?refresh=true or POST busts the server-side cache
  const force = req.query.refresh === 'true' || req.method === 'POST';
  if (force) azure.clearLocationCache();
  try {
    const locations = await azure.listLocations();
    if (!locations.length) {
      return res.json({
        locations: [],
        message: 'No deployment regions are available for this subscription.',
      });
    }
    res.json({ locations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Resource Groups ────────────────────────────────────────────────────────

async function listResourceGroups(req, res) {
  const groups = await azure.listResourceGroups();
  res.json({ resourceGroups: groups });
}

async function createResourceGroup(req, res) {
  const { name, location = 'eastus', tags } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const rg = await azure.createResourceGroup(name, location, tags || {});
  res.json({ resourceGroup: rg });
}

async function deleteResourceGroup(req, res) {
  const { name } = req.params;
  await azure.deleteResourceGroup(name);
  res.json({ success: true });
}

// ── App Service Plans ──────────────────────────────────────────────────────

async function listPlans(req, res) {
  const plans = await azure.listAppServicePlans();
  res.json({ plans });
}

async function createPlan(req, res) {
  const { resourceGroup, name, location = 'eastus', sku = 'B1', isLinux = true } = req.body;
  if (!resourceGroup || !name) return res.status(400).json({ error: 'resourceGroup and name are required' });
  const plan = await azure.createAppServicePlan(resourceGroup, name, location, sku, isLinux);
  res.json({ plan });
}

// ── Web Apps ───────────────────────────────────────────────────────────────

async function listApps(req, res) {
  const apps = await azure.listApps();
  res.json({ apps });
}

async function getApp(req, res) {
  const { resourceGroup, name } = req.params;
  const app = await azure.getApp(resourceGroup, name);
  res.json({ app });
}

async function createApp(req, res) {
  const { resourceGroup, name, location = 'eastus', planId, runtimeStack = 'NODE|18-lts' } = req.body;
  if (!resourceGroup || !name || !planId) {
    return res.status(400).json({ error: 'resourceGroup, name, and planId are required' });
  }
  const app = await azure.createApp(resourceGroup, name, location, planId, runtimeStack);
  res.json({ app });
}

async function deleteApp(req, res) {
  const { resourceGroup, name } = req.params;
  await azure.deleteApp(resourceGroup, name);
  res.json({ success: true });
}

async function startApp(req, res) {
  const { resourceGroup, name } = req.params;
  await azure.startApp(resourceGroup, name);
  res.json({ success: true });
}

async function stopApp(req, res) {
  const { resourceGroup, name } = req.params;
  await azure.stopApp(resourceGroup, name);
  res.json({ success: true });
}

async function restartApp(req, res) {
  const { resourceGroup, name } = req.params;
  await azure.restartApp(resourceGroup, name);
  res.json({ success: true });
}

// ── Environment Variables ──────────────────────────────────────────────────

async function getEnvVars(req, res) {
  const { resourceGroup, name } = req.params;
  const settings = await azure.getAppSettings(resourceGroup, name);
  res.json({ settings });
}

async function updateEnvVars(req, res) {
  const { resourceGroup, name } = req.params;
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings must be a key-value object' });
  }
  const result = await azure.updateAppSettings(resourceGroup, name, settings);
  res.json({ result });
}

// ── Deployment ─────────────────────────────────────────────────────────────

async function deployFromGitHub(req, res) {
  const { resourceGroup, name } = req.params;
  const {
    repoUrl,
    branch = 'main',
    rootDir = '.',
    buildCommand = '',
    startCommand = '',
  } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  const userId = req.session.userId || req.userId;
  const user = await User.findById(userId).select('githubToken');
  const githubToken = user?.githubToken ? cryptoSvc.decrypt(user.githubToken) : '';
  const trackedApp = await AzureApp.findOne({ resourceGroup, name });

  if (trackedApp) {
    trackedApp.status = 'deploying';
    trackedApp.lastError = '';
    await trackedApp.save();
  }

  const logs = [];
  try {
    const result = await azureDeploy.deployToAppService({
      resourceGroup,
      name,
      repoUrl,
      branch,
      githubToken,
      rootDir,
      buildCommand,
      startCommand,
      log: (level, message) => logs.push({ level, message, ts: new Date() }),
    });

    if (trackedApp) {
      trackedApp.status = 'running';
      trackedApp.lastError = '';
      trackedApp.lastDeployedAt = new Date();
      await trackedApp.save();
    }

    return res.json({
      success: true,
      message: 'Application deployed and verified in Azure App Service.',
      deploymentId: result.deploymentId,
      packageManager: result.packageManager,
      startCommand: result.startCommand,
      logs: result.logs,
    });
  } catch (err) {
    if (trackedApp) {
      trackedApp.status = 'failed';
      trackedApp.lastError = err.message;
      await trackedApp.save().catch(() => {});
    }

    // Preserve the complete Kudu/Azure details for callers instead of
    // reducing an upload failure to a generic HTTP 502.
    return res.status(err.azureStatus && err.azureStatus >= 400 ? err.azureStatus : 500).json({
      success: false,
      error: err.message,
      azureStatus: err.azureStatus,
      deploymentId: err.deploymentId,
      deploymentLog: err.deploymentLog,
      logs: err.logs || logs,
    });
  }
}

async function syncDeployment(req, res) {
  const { resourceGroup, name } = req.params;
  await azure.syncDeploy(resourceGroup, name);
  res.json({ success: true, message: 'Sync triggered' });
}

async function listDeployments(req, res) {
  const { resourceGroup, name } = req.params;
  const deployments = await azure.listDeployments(resourceGroup, name);
  res.json({ deployments });
}

// ── Monitoring ─────────────────────────────────────────────────────────────

async function getMetrics(req, res) {
  const { resourceGroup, name } = req.params;
  const { range = '24h' } = req.query;
  const metrics = await azure.getMetrics(resourceGroup, name, range);
  res.json({ metrics });
}

// ── Logs ───────────────────────────────────────────────────────────────────

async function getLogs(req, res) {
  const { resourceGroup, name } = req.params;
  const logs = await azure.getRecentLogs(resourceGroup, name);
  res.json({ logs });
}

// ── Domains ────────────────────────────────────────────────────────────────

async function listDomains(req, res) {
  const { resourceGroup, name } = req.params;
  const domains = await azure.listHostNames(resourceGroup, name);
  res.json({ domains });
}

async function addDomain(req, res) {
  const { resourceGroup, name } = req.params;
  const { hostname } = req.body;
  if (!hostname) return res.status(400).json({ error: 'hostname is required' });
  const result = await azure.addCustomDomain(resourceGroup, name, hostname);
  res.json({ result });
}

async function removeDomain(req, res) {
  const { resourceGroup, name, hostname } = req.params;
  await azure.removeCustomDomain(resourceGroup, name, hostname);
  res.json({ success: true });
}

// ── Scaling ────────────────────────────────────────────────────────────────

async function scaleApp(req, res) {
  const { resourceGroup, planName } = req.params;
  const { instanceCount } = req.body;
  if (!instanceCount || instanceCount < 1) {
    return res.status(400).json({ error: 'instanceCount must be >= 1' });
  }
  const result = await azure.scaleApp(resourceGroup, planName, instanceCount);
  res.json({ result });
}

async function getInstanceCount(req, res) {
  const { resourceGroup, planName } = req.params;
  const count = await azure.getAppInstanceCount(resourceGroup, planName);
  res.json({ instanceCount: count });
}

// ── Cost ───────────────────────────────────────────────────────────────────

async function getCost(req, res) {
  try {
    const cost = await azure.getCostSummary();
    res.json({ cost });
  } catch {
    // Cost Management API may not be available on all subscriptions
    res.json({ cost: null });
  }
}

// ── fireboxdeploy.toml auto-detect ─────────────────────────────────────────

async function detectToml(req, res) {
  const { repo, branch = 'main' } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  const config = await tomlService.fetchFromGitHub(repo, branch);
  res.json({ config });
}

// ── FireboxDeploy-tracked Azure Apps ──────────────────────────────────────

async function listTrackedApps(req, res) {
  const userId = req.session.userId || req.userId;
  const apps = await AzureApp.find({ owner: userId }).sort({ createdAt: -1 });
  res.json({ apps });
}

async function createTrackedApp(req, res) {
  const userId = req.session.userId || req.userId;
  const {
    name, resourceGroup, region, planName, planSku,
    runtime, runtimeVersion, repoUrl, branch, rootDir,
    buildCommand, startCommand, port, envVars,
  } = req.body;

  if (!name || !resourceGroup) {
    return res.status(400).json({ error: 'name and resourceGroup are required' });
  }

  const app = await AzureApp.create({
    name, resourceGroup,
    region:         region        || 'East US',
    planName:       planName      || '',
    planSku:        planSku       || 'F1',
    runtime:        runtime       || 'nodejs',
    runtimeVersion: runtimeVersion || '',
    repoUrl:        repoUrl       || '',
    branch:         branch        || 'main',
    rootDir:        rootDir       || '.',
    buildCommand:   buildCommand  || '',
    startCommand:   startCommand  || '',
    port:           port          || 8080,
    envVars:        Array.isArray(envVars) ? envVars : [],
    status:         'idle',
    owner:          userId,
  });

  res.status(201).json({ app });
}

async function deleteTrackedApp(req, res) {
  const app = await AzureApp.findById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  await app.deleteOne();
  res.json({ success: true });
}

module.exports = {
  getStatus, saveCredentials, verifyConnection, deleteCredentials,
  getDashboard,
  listLocations,
  listResourceGroups, createResourceGroup, deleteResourceGroup,
  listPlans, createPlan,
  listApps, getApp, createApp, deleteApp, startApp, stopApp, restartApp,
  getEnvVars, updateEnvVars,
  deployFromGitHub, syncDeployment, listDeployments,
  getMetrics,
  getLogs,
  listDomains, addDomain, removeDomain,
  scaleApp, getInstanceCount,
  getCost,
  detectToml,
  listTrackedApps, createTrackedApp, deleteTrackedApp,
};
