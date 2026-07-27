const Project      = require('../models/Project');
const Deployment   = require('../models/Deployment');
const deployService = require('../services/deploy.service');

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── CRUD ──────────────────────────────────────────────────────────────────

async function listProjects(req, res) {
  const userId   = req.session.userId || req.userId;
  const projects = await Project.find({ owner: userId }).sort({ createdAt: -1 });
  res.json({ projects });
}

async function getProject(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
}

async function createProject(req, res) {
  const {
    name, type, githubRepoFullName, repoUrl,
    githubBranch, rootDirectory,
    buildCommand, startCommand, envVars, customDomain,
    deployPath, pm2Name, vpsUrl,
  } = req.body;

  if (!name)    return res.status(400).json({ error: 'Project name is required' });
  if (!repoUrl && !githubRepoFullName) {
    return res.status(400).json({ error: 'A repository is required' });
  }

  const userId = req.session.userId || req.userId;

  // Build a unique slug
  const baseSlug = slugify(name);
  let slug = baseSlug, n = 1;
  while (await Project.findOne({ slug })) slug = `${baseSlug}-${n++}`;

  const project = await Project.create({
    name,
    slug,
    type:               type || 'node-app',
    owner:              userId,
    githubRepoFullName: githubRepoFullName || '',
    repoUrl:            repoUrl || `https://github.com/${githubRepoFullName}`,
    githubBranch:       githubBranch || 'main',
    rootDirectory:      rootDirectory || '.',
    buildCommand:       buildCommand  || '',
    startCommand:       startCommand  || '',
    envVars:            Array.isArray(envVars) ? envVars : [],
    customDomain:       customDomain  || '',
    deployPath:         deployPath    || '',
    pm2Name:            pm2Name       || '',
    vpsUrl:             vpsUrl        || '',
    status:             'idle',
  });

  res.status(201).json({ project });
}

async function updateProject(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const editable = [
    'name', 'githubBranch', 'rootDirectory', 'buildCommand', 'startCommand',
    'customDomain', 'type', 'deployPath', 'pm2Name', 'vpsUrl',
  ];
  editable.forEach((f) => { if (req.body[f] !== undefined) project[f] = req.body[f]; });
  await project.save();
  res.json({ project });
}

async function deleteProject(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  await Deployment.deleteMany({ project: project._id });
  await project.deleteOne();
  res.json({ success: true });
}

// ── Env vars ──────────────────────────────────────────────────────────────

async function getEnvVars(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ envVars: project.envVars || [] });
}

async function updateEnvVars(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { envVars } = req.body;
  if (!Array.isArray(envVars)) return res.status(400).json({ error: 'envVars must be an array' });

  project.envVars = envVars.filter((e) => e.key).map((e) => ({
    key:    e.key,
    value:  e.value,
    secret: !!e.secret,
  }));
  await project.save();
  res.json({ project });
}

// ── Domains ───────────────────────────────────────────────────────────────

async function getDomains(req, res) {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const domains = [];
  if (project.vpsUrl)      domains.push({ id: 'vps',    domain: project.vpsUrl,      type: 'vps' });
  if (project.customDomain) domains.push({ id: 'custom', domain: project.customDomain, type: 'custom' });

  res.json({ domains, customDomain: project.customDomain, vpsUrl: project.vpsUrl });
}

async function addDomain(req, res) {
  const { domain, type } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (type === 'vps') {
    project.vpsUrl = domain;
  } else {
    project.customDomain = domain;
  }
  await project.save();
  res.json({ success: true, project });
}

async function removeDomain(req, res) {
  const { domainId } = req.params;
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (domainId === 'vps')    project.vpsUrl      = '';
  if (domainId === 'custom') project.customDomain = '';
  await project.save();
  res.json({ success: true });
}

module.exports = {
  listProjects, getProject, createProject, updateProject, deleteProject,
  getEnvVars, updateEnvVars,
  getDomains, addDomain, removeDomain,
};
