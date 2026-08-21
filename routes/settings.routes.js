const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/settings.controller');

router.use(requireAuth);

router.get('/',                         ctrl.getSettings);
router.post('/ssh-credentials',         ctrl.saveSshCredentials);
router.post('/ssh-credentials/test',   ctrl.testSshConnection);
router.post('/ssh-credentials/test-tcp', ctrl.testOutboundTcp);
router.post('/ssh-credentials/outbound-ip', ctrl.getOutboundIp);
router.post('/azure-agent/test', ctrl.testAzureAgentConnection);
router.delete('/ssh-credentials',       ctrl.deleteSshCredentials);
router.post('/github-token',            ctrl.saveGithubToken);
router.delete('/github-token',          ctrl.deleteGithubToken);

module.exports = router;
