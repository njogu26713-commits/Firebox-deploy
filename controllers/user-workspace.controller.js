const UserWorkspace = require('../models/UserWorkspace');
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

module.exports = { getWorkspace, getGithubConnection, saveGithubConnection, addProject, addUploadedProject, recordDeployment };
