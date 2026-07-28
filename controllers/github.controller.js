const User   = require('../models/User');
const github = require('../services/github.service');
const crypto = require('../services/crypto.service');

async function listRepos(req, res) {
  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user || !user.githubToken) {
    return res.status(400).json({ error: 'No GitHub token configured. Add one in Settings.' });
  }

  try {
    const token = crypto.decrypt(user.githubToken);
    const repos  = await github.listRepos(token);
    res.json({ repos });
  } catch (err) {
    res.status(502).json({ error: `GitHub API error: ${err.message}` });
  }
}

async function detectCommands(req, res) {
  const { repo, branch } = req.query;
  if (!repo) return res.status(400).json({ error: 'Missing ?repo=owner/name' });

  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user || !user.githubToken) {
    return res.status(400).json({ error: 'No GitHub token configured. Add one in Settings.' });
  }

  try {
    const token  = crypto.decrypt(user.githubToken);
    const result = await github.detectCommands(repo, branch || 'main', token);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `GitHub API error: ${err.message}` });
  }
}

module.exports = { listRepos, detectCommands };
