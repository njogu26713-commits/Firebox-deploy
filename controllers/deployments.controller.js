const Project       = require('../models/Project');
const Deployment    = require('../models/Deployment');
const deployService = require('../services/deploy.service');

// ── Trigger deploy ────────────────────────────────────────────────────────

async function triggerDeploy(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { deploymentId } = await deployService.triggerDeploy(project, 'manual');
    res.status(202).json({ deploymentId, projectId: project._id });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

async function triggerRedeploy(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { deploymentId } = await deployService.triggerDeploy(project, 'redeploy');
    res.status(202).json({ deploymentId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

async function triggerRollback(req, res) {
  // SSH/PM2 deployments don't support automatic rollback.
  // Guide the user to redeploy from a previous commit instead.
  res.status(400).json({
    error: 'Rollback is not available for SSH/PM2 deployments. ' +
           'To roll back, check out a previous commit on your VPS or push a revert commit and redeploy.',
  });
}

// ── History ───────────────────────────────────────────────────────────────

async function listDeployments(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const deployments = await Deployment.find({ project: project._id })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  res.json({ deployments });
}

async function getDeployment(req, res) {
  const deployment = await Deployment.findById(req.params.deploymentId).populate('project', 'name slug');
  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
  res.json({ deployment });
}

async function getDeploymentLogs(req, res) {
  const deployment = await Deployment.findById(req.params.deploymentId).lean();
  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });

  // Return stored log lines from the deployment document
  res.json({ logs: deployment.logs || [] });
}

module.exports = {
  triggerDeploy, triggerRedeploy, triggerRollback,
  listDeployments, getDeployment, getDeploymentLogs,
};
