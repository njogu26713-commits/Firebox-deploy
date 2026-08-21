const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/user-auth.controller');
const { requireUserAuth } = require('../middleware/user-auth.middleware');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.post('/logout', ctrl.logout);
router.get('/me', requireUserAuth, ctrl.me);

module.exports = router;
