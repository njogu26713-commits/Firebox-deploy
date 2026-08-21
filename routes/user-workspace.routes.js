const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/user-workspace.controller');

router.get('/', ctrl.getWorkspace);
router.post('/projects', ctrl.addProject);
router.post('/deployments', ctrl.recordDeployment);

module.exports = router;
