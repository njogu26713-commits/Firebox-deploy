const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl     = require('../controllers/projects.controller');
const deplCtrl = require('../controllers/deployments.controller');

router.use(requireAuth);

// Project CRUD
router.get('/',    ctrl.listProjects);
router.post('/',   ctrl.createProject);
router.get('/:id', ctrl.getProject);
router.patch('/:id', ctrl.updateProject);
router.delete('/:id', ctrl.deleteProject);

// Deployments under a project
router.post('/:id/deploy',     deplCtrl.triggerDeploy);
router.post('/:id/redeploy',   deplCtrl.triggerRedeploy);
router.post('/:id/rollback',   deplCtrl.triggerRollback);
router.get('/:id/deployments', deplCtrl.listDeployments);

// Env vars
router.get('/:id/env', ctrl.getEnvVars);
router.put('/:id/env', ctrl.updateEnvVars);

// Domains
router.get('/:id/domains',              ctrl.getDomains);
router.post('/:id/domains',             ctrl.addDomain);
router.delete('/:id/domains/:domainId', ctrl.removeDomain);

module.exports = router;
