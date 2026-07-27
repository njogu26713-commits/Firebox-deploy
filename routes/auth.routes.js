const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/auth.controller');

router.post('/login',  ctrl.login);
router.post('/logout', ctrl.logout);
router.get('/me',      requireAuth, ctrl.me);

module.exports = router;
