const UserWorkspace = require('../models/UserWorkspace');
const Project = require('../models/Project');
const Deployment = require('../models/Deployment');
const User = require('../models/User');
const config = require('../config/config');
const deployService = require('../services/deploy.service');
const { encrypt } = require('../services/crypto.service');

function sessionKey(req) {
  return `user:${req.userAccountId}`;
}

async function getWorkspace(req, res, next) {
  try {
    const workspace = await UserWorkspace.findOne({ sessionKey: sessionKey(req) }).lean();
    res.json({ workspace: workspace || { projects: [], activity: [] } });
  } catch (err) { next(err); }
}

async function getGithubConnection(req, res, next) {
  try {
    const workspace = await UserWorkspace.findOne({ sessionKey: sessionKey(req) }).lean();
    res.json({ connected: !!(workspace && workspace.githubToken), username: workspace?.githubUsername || '', authMethod: workspace?.githubAuthMethod || null, connectedAt: workspace?.githubConnectedAt || null });
  } catch (err) { next(err); }
}

async function saveGithubConnection(req, res, next) {
  try {
    const username = String(req.body.username || '').trim().slice(0, 120);
    const token = String(req.body.token || '').trim();
    if (!username || !token) return res.status(400).json({ error: 'GitHub username and personal access token are required.' });
    const workspace = await UserWorkspace.findOneAndUpdate(
      { sessionKey: sessionKey(req) },
      { $set: { githubUsername: username, githubToken: encrypt(token), githubConnectedAt: new Date(), githubAuthMethod: 'pat' }, $setOnInsert: { sessionKey: sessionKey(req) } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.json({ connected: true, username: workspace.githubUsername, connectedAt: workspace.githubConnectedAt });
  } catch (err) { next(err); }
}

async function addProject(req, res, next) {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const repoUrl = String(req.body.repoUrl || '').trim().slice(0, 500);
    const branch = String(req.body.branch || 'main').trim().slice(0, 120) || 'main';
    const provider = String(req.body.provider || 'railway').trim().toLowerCase();
    if (!name || !repoUrl || !/^https?:\/\//i.test(repoUrl)) return res.status(400).json({ error: 'Project name and a valid repository URL are required.' });
    if (!['railway', 'vercel', 'heroku', 'render'].includes(provider)) return res.status(400).json({ error: 'Unsupported deployment provider.' });
    const workspace = await UserWorkspace.findOneAndUpdate(
      { sessionKey: sessionKey(req) },
      { $setOnInsert: { sessionKey: sessionKey(req) }, $push: { projects: { name, repoUrl, branch, provider } } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.status(201).json({ workspace });
  } catch (err) { next(err); }
}

async function addUploadedProject(req, res, next) {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const provider = String(req.body.provider || 'railway').trim().toLowerCase();
    const files = Array.isArray(req.files) ? req.files : [];
    if (!name || !files.length) return res.status(400).json({ error: 'Project name and at least one folder file are required.' });
    if (!['railway', 'vercel', 'heroku', 'render'].includes(provider)) return res.status(400).json({ error: 'Unsupported deployment provider.' });
    const workspace = await UserWorkspace.findOneAndUpdate(
      { sessionKey: sessionKey(req) },
      { $setOnInsert: { sessionKey: sessionKey(req) }, $push: { projects: { name, repoUrl: `uploaded://${name}`, branch: 'local', provider, sourceType: 'upload', uploadedFileCount: files.length, uploadPath: files[0].destination || '' } } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.status(201).json({ workspace, uploadedFileCount: files.length });
  } catch (err) { next(err); }
}

function slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'user-project'; }

async function deployProject(req, res, next) {
  try {
    const workspace = await UserWorkspace.findOne({ sessionKey: sessionKey(req) });
    if (!workspace) return res.status(404).json({ error: 'User workspace not found.' });
    const project = workspace.projects.id(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'User project not found.' });
    if (project.sourceType === 'upload') return res.status(400).json({ error: 'Folder uploads are saved in your workspace, but VPS deployment currently requires a GitHub repository.' });
    const admin = await User.findOne({ $or: [{ email: config.adminEmail.toLowerCase() }, { role: 'owner' }] });
    if (!admin) return res.status(503).json({ error: 'Admin deployment settings are not configured.' });
    if (!admin.sshHost || !admin.sshUsername || (!admin.sshPrivateKey && !admin.sshPassword)) return res.status(503).json({ error: 'The admin must configure VPS SSH credentials in the admin Settings page first.' });
    let deploymentProject = project.deploymentProjectId ? await Project.findById(project.deploymentProjectId) : null;
    if (!deploymentProject) {
      const baseSlug = slugify(project.name);
      let slug = `user-${baseSlug}`;
      let suffix = 1;
      while (await Project.exists({ slug })) { slug = `user-${baseSlug}-${suffix++}`; }
      deploymentProject = await Project.create({ name: project.name, slug, owner: admin._id, type: 'node-app', repoUrl: project.repoUrl, githubBranch: project.branch || 'main', githubToken: workspace.githubToken || '', pm2Name: slug });
      project.deploymentProjectId = deploymentProject._id;
    } else {
      deploymentProject.repoUrl = project.repoUrl;
      deploymentProject.githubBranch = project.branch || 'main';
      deploymentProject.githubToken = workspace.githubToken || '';
      await deploymentProject.save();
    }
    const { deploymentId } = await deployService.triggerDeploy(deploymentProject, 'manual');
    project.lastDeploymentId = deploymentId;
    workspace.activity.push({ projectName: project.name, provider: 'vps', status: 'queued' });
    await workspace.save();
    res.status(202).json({ deploymentId, status: 'queued', message: 'Deployment started on the Firebox Deploy VPS.' });
  } catch (err) { next(err); }
}

async function getDeploymentStatus(req, res, next) {
  try {
    const workspace = await UserWorkspace.findOne({ sessionKey: sessionKey(req) }).lean();
    const project = workspace?.projects.find((item) => item._id.toString() === req.params.projectId);
    if (!project || !project.lastDeploymentId || project.lastDeploymentId.toString() !== req.params.deploymentId) return res.status(404).json({ error: 'Deployment not found.' });
    const deployment = await Deployment.findById(project.lastDeploymentId).lean();
    if (!deployment) return res.status(404).json({ error: 'Deployment not found.' });
    res.json({ deployment: { id: deployment._id, status: deployment.status, url: deployment.url, logs: deployment.logs || [], triggeredAt: deployment.triggeredAt, completedAt: deployment.completedAt } });
  } catch (err) { next(err); }
}

async function recordDeployment(req, res, next) {
  try {
    const projectName = String(req.body.projectName || '').trim().slice(0, 120);
    const repoUrl = String(req.body.repoUrl || '').trim().slice(0, 500);
    const provider = String(req.body.provider || '').trim().toLowerCase();
    if (!projectName || !repoUrl || !provider) return res.status(400).json({ error: 'Project, repository, and provider are required.' });
    const workspace = await UserWorkspace.findOneAndUpdate(
      { sessionKey: sessionKey(req) },
      { $setOnInsert: { sessionKey: sessionKey(req) }, $push: { activity: { projectName, provider, status: 'requested' } } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.status(201).json({ workspace });
  } catch (err) { next(err); }
}

module.exports = { getWorkspace, getGithubConnection, saveGithubConnection, addProject, addUploadedProject, deployProject, getDeploymentStatus, recordDeployment };
