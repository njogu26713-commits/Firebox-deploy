const express = require('express');
const path    = require('path');
const router  = express.Router();
const { requirePageAuth } = require('../middleware/auth.middleware');
const config = require('../config/config');

const views = (file) => path.join(__dirname, '..', 'views', file);

router.get('/', (req, res) => res.sendFile(views('landing.html')));

router.get('/login',         (req, res) => {
  if (config.authDisabled || req.session.userId) return res.redirect('/dashboard');
  res.sendFile(views('login.html'));
});

router.get('/home',              requirePageAuth, (req, res) => res.sendFile(views('home.html')));
router.get('/dashboard',         requirePageAuth, (req, res) => res.sendFile(views('dashboard.html')));
router.get('/projects/new',      requirePageAuth, (req, res) => res.sendFile(views('new-project.html')));
router.get('/deploy',            requirePageAuth, (req, res) => res.sendFile(views('deploy.html')));
router.get('/request-deploy',     (req, res) => res.sendFile(views('request-deploy.html')));
router.get('/admin/requests',     requirePageAuth, (req, res) => res.sendFile(views('admin-requests.html')));
router.get('/history',            requirePageAuth, (req, res) => res.sendFile(views('history.html')));
router.get('/app/home',          requirePageAuth, (req, res) => res.sendFile(views('user-home.html')));
router.get('/app/projects',       requirePageAuth, (req, res) => res.sendFile(views('user-projects.html')));
router.get('/app/source-control', requirePageAuth, (req, res) => res.sendFile(views('user-source-control.html')));
router.get('/app/history',        requirePageAuth, (req, res) => res.sendFile(views('user-history.html')));
router.get('/app/deploy',         requirePageAuth, (req, res) => res.sendFile(views('user-deploy.html')));
router.get('/app/settings',       requirePageAuth, (req, res) => res.sendFile(views('user-settings.html')));
router.get('/projects/:id',      requirePageAuth, (req, res) => res.sendFile(views('project-detail.html')));
router.get('/settings',          requirePageAuth, (req, res) => res.sendFile(views('settings.html')));
router.get('/azure',             requirePageAuth, (req, res) => res.sendFile(views('azure.html')));

module.exports = router;
