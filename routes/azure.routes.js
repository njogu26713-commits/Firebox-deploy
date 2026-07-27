const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/azure.controller');

// All routes require auth
router.use(requireAuth);

// ── Credentials & status
router.get('/status',                            ctrl.getStatus);
router.post('/credentials',                      ctrl.saveCredentials);
router.post('/credentials/verify',               ctrl.verifyConnection);
router.delete('/credentials',                    ctrl.deleteCredentials);

// ── Dashboard summary
router.get('/dashboard',                         ctrl.getDashboard);

// ── Locations / Regions (dynamic, subscription-scoped)
router.get('/locations',                         ctrl.listLocations);
router.post('/locations/refresh',                ctrl.listLocations); // force cache bust

// ── Cost
router.get('/cost',                              ctrl.getCost);

// ── Resource Groups
router.get('/resource-groups',                   ctrl.listResourceGroups);
router.post('/resource-groups',                  ctrl.createResourceGroup);
router.delete('/resource-groups/:name',          ctrl.deleteResourceGroup);

// ── App Service Plans
router.get('/plans',                             ctrl.listPlans);
router.post('/plans',                            ctrl.createPlan);

// ── FireboxDeploy-tracked Azure Apps (local DB records)
router.get('/tracked-apps',                      ctrl.listTrackedApps);
router.post('/tracked-apps',                     ctrl.createTrackedApp);
router.delete('/tracked-apps/:id',               ctrl.deleteTrackedApp);

// ── Live Azure Web Apps (via Azure API)
router.get('/apps',                              ctrl.listApps);
router.post('/apps',                             ctrl.createApp);
router.get('/apps/:resourceGroup/:name',         ctrl.getApp);
router.delete('/apps/:resourceGroup/:name',      ctrl.deleteApp);
router.post('/apps/:resourceGroup/:name/start',  ctrl.startApp);
router.post('/apps/:resourceGroup/:name/stop',   ctrl.stopApp);
router.post('/apps/:resourceGroup/:name/restart',ctrl.restartApp);

// ── App environment variables
router.get('/apps/:resourceGroup/:name/env',     ctrl.getEnvVars);
router.put('/apps/:resourceGroup/:name/env',     ctrl.updateEnvVars);

// ── Deployment (JSON — kept for API/webhook callers)
router.post('/apps/:resourceGroup/:name/deploy', ctrl.deployFromGitHub);

// ── Deployment streaming via SSE (used by the dashboard UI)
router.post('/apps/:resourceGroup/:name/deploy-stream', ctrl.streamDeploy);

router.post('/apps/:resourceGroup/:name/sync',   ctrl.syncDeployment);
router.get('/apps/:resourceGroup/:name/deployments', ctrl.listDeployments);

// ── FireboxDeploy deployment history (persisted in local DB)
router.get('/apps/:resourceGroup/:name/deploy-history',  ctrl.listAzureDeployments);
router.get('/deploy-log/:deploymentId',                  ctrl.getAzureDeploymentLog);

// ── Monitoring
router.get('/apps/:resourceGroup/:name/metrics', ctrl.getMetrics);

// ── Logs
router.get('/apps/:resourceGroup/:name/logs',    ctrl.getLogs);

// ── Domains
router.get('/apps/:resourceGroup/:name/domains',              ctrl.listDomains);
router.post('/apps/:resourceGroup/:name/domains',             ctrl.addDomain);
router.delete('/apps/:resourceGroup/:name/domains/:hostname', ctrl.removeDomain);

// ── Scaling
router.get('/plans/:resourceGroup/:planName/instance-count', ctrl.getInstanceCount);
router.post('/plans/:resourceGroup/:planName/scale',         ctrl.scaleApp);

// ── fireboxdeploy.toml auto-detect
router.get('/toml-detect', ctrl.detectToml);

module.exports = router;
