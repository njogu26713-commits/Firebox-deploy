const express = require('express');
const path    = require('path');
const router  = express.Router();
const { requirePageAuth } = require('../middleware/auth.middleware');
const config = require('../config/config');

const views = (file) => path.join(__dirname, '..', 'views', file);

router.get('/', (req, res) => res.sendFile(views('landing.html')));

router.get('/user-login',    (req, res) => res.sendFile(views('user-login.html')));
router.get('/user',          (req, res) => res.sendFile(views('user-app.html')));
router.get('/login',         (req, res) => {
  if (config.authDisabled || req.session.userId) return res.redirect('/dashboard');
  res.sendFile(views('login.html'));
});

router.get('/home',              (req, res) => res.sendFile(views('user-app.html')));
router.get('/dashboard',         requirePageAuth, (req, res) => res.sendFile(views('dashboard.html')));
router.get('/projects/new',      requirePageAuth, (req, res) => res.sendFile(views('new-project.html')));
router.get('/deploy',            requirePageAuth, (req, res) => res.sendFile(views('deploy.html')));
router.get('/request-deploy',     (req, res) => res.sendFile(views('request-deploy.html')));
router.get('/admin/requests',     requirePageAuth, (req, res) => res.sendFile(views('admin-requests.html')));
router.get('/history',            requirePageAuth, (req, res) => res.sendFile(views('history.html')));
router.get('/app',              (req, res) => res.redirect('/app/home'));
router.get('/app/home',          (req, res) => res.sendFile(views('user-app.html')));
router.get('/app/projects',       (req, res) => res.redirect('/app/home#projects'));
router.get('/app/source-control', (req, res) => res.redirect('/app/home#source'));
router.get('/app/history',        (req, res) => res.redirect('/app/home#history'));
router.get('/app/deploy',         (req, res) => res.redirect('/app/home#deploy'));
router.get('/app/settings',       (req, res) => res.redirect('/app/home#settings'));
router.get('/projects/:id',      requirePageAuth, (req, res) => res.sendFile(views('project-detail.html')));
router.get('/settings',          requirePageAuth, (req, res) => res.sendFile(views('settings.html')));
router.get('/azure',             requirePageAuth, (req, res) => res.sendFile(views('azure.html')));

module.exports = router;
