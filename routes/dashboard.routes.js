const express = require('express');
const path    = require('path');
const router  = express.Router();
const { requirePageAuth } = require('../middleware/auth.middleware');
const config = require('../config/config');

const views = (file) => path.join(__dirname, '..', 'views', file);

router.get('/', (req, res) => res.redirect(config.authDisabled || req.session.userId ? '/dashboard' : '/login'));

router.get('/login',         (req, res) => {
  if (config.authDisabled || req.session.userId) return res.redirect('/dashboard');
  res.sendFile(views('login.html'));
});

router.get('/dashboard',         requirePageAuth, (req, res) => res.sendFile(views('dashboard.html')));
router.get('/projects/new',      requirePageAuth, (req, res) => res.sendFile(views('new-project.html')));
router.get('/deploy',            requirePageAuth, (req, res) => res.sendFile(views('deploy.html')));
router.get('/projects/:id',      requirePageAuth, (req, res) => res.sendFile(views('project-detail.html')));
router.get('/settings',          requirePageAuth, (req, res) => res.sendFile(views('settings.html')));
router.get('/azure',             requirePageAuth, (req, res) => res.sendFile(views('azure.html')));

module.exports = router;
