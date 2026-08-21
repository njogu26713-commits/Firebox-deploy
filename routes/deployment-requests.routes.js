const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/deployment-requests.controller');

// Public user-facing request form.
router.post('/', ctrl.createRequest);

// Admin dashboard operations.
router.get('/', requireAuth, ctrl.listRequests);
router.patch('/:id', requireAuth, ctrl.updateRequest);

module.exports = router;
