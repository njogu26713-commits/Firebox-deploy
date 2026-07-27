const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/github.controller');

router.use(requireAuth);
router.get('/repos',   ctrl.listRepos);
router.get('/detect', ctrl.detectCommands);

module.exports = router;
