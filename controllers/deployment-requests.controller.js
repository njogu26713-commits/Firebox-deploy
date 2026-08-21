const DeploymentRequest = require('../models/DeploymentRequest');

const PROVIDERS = new Set(['railway', 'vercel', 'heroku', 'render']);

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

async function createRequest(req, res, next) {
  try {
    const requesterName = clean(req.body.requesterName, 120);
    const requesterEmail = clean(req.body.requesterEmail, 180).toLowerCase();
    const projectName = clean(req.body.projectName, 120);
    const provider = clean(req.body.provider, 30).toLowerCase();
    const repoUrl = clean(req.body.repoUrl, 500);
    const branch = clean(req.body.branch, 120) || 'main';
    const notes = clean(req.body.notes, 2000);

    if (!requesterName || !requesterEmail || !projectName || !repoUrl || !PROVIDERS.has(provider)) {
      return res.status(400).json({ error: 'Name, email, project name, provider, and repository URL are required.' });
    }
    if (!/^https?:\/\//i.test(repoUrl)) {
      return res.status(400).json({ error: 'Repository URL must start with http:// or https://.' });
    }

    const request = await DeploymentRequest.create({
      requesterName, requesterEmail, projectName, provider, repoUrl, branch, notes,
    });
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
}

async function listRequests(req, res, next) {
  try {
    const requests = await DeploymentRequest.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ requests });
  } catch (err) {
    next(err);
  }
}

async function updateRequest(req, res, next) {
  try {
    const updates = {};
    if (req.body.status) {
      if (!['pending', 'approved', 'rejected', 'deployed'].includes(req.body.status)) {
        return res.status(400).json({ error: 'Invalid request status.' });
      }
      updates.status = req.body.status;
      updates.reviewedAt = new Date();
    }
    if (req.body.adminNotes !== undefined) updates.adminNotes = clean(req.body.adminNotes, 2000);
    const request = await DeploymentRequest.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true }).lean();
    if (!request) return res.status(404).json({ error: 'Deployment request not found.' });
    res.json({ request });
  } catch (err) {
    next(err);
  }
}

module.exports = { createRequest, listRequests, updateRequest };
