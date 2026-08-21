const UserWorkspace = require('../models/UserWorkspace');

function sessionKey(req) {
  return `user:${req.userAccountId}`;
}

async function getWorkspace(req, res, next) {
  try {
    const workspace = await UserWorkspace.findOne({ sessionKey: sessionKey(req) }).lean();
    res.json({ workspace: workspace || { projects: [], activity: [] } });
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

module.exports = { getWorkspace, addProject, recordDeployment };
