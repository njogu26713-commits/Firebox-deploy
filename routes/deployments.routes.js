const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/deployments.controller');

router.use(requireAuth);

router.get('/:deploymentId',      ctrl.getDeployment);
router.get('/:deploymentId/logs', ctrl.getDeploymentLogs);

module.exports = router;
