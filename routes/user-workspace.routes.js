const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const ctrl = require('../controllers/user-workspace.controller');
const githubCtrl = require('../controllers/user-github.controller');
const { requireUserAuth } = require('../middleware/user-auth.middleware');
const uploadRoot = path.join(__dirname, '..', 'uploads', 'user-projects');
fs.mkdirSync(uploadRoot, { recursive: true });
const upload = multer({ dest: uploadRoot, limits: { files: 500, fileSize: 20 * 1024 * 1024 } });
router.use(requireUserAuth);

router.get('/', ctrl.getWorkspace);
router.get('/github-connection', ctrl.getGithubConnection);
router.get('/github/oauth/start', githubCtrl.startOAuth);
router.get('/github/oauth/callback', githubCtrl.oauthCallback);
router.put('/github-connection', ctrl.saveGithubConnection);
router.post('/projects', ctrl.addProject);
router.post('/projects/upload', upload.array('files', 500), ctrl.addUploadedProject);
router.post('/deployments', ctrl.recordDeployment);

module.exports = router;
