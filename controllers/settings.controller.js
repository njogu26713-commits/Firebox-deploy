const User   = require('../models/User');
const crypto = require('../services/crypto.service');

async function getSettings(req, res) {
  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ settings: user.toSafeJSON() });
}

// ── SSH credentials ───────────────────────────────────────────────────────

async function saveSshCredentials(req, res) {
  const { host, port, username, privateKey, password, deployRoot } = req.body;

  if (!host || !host.trim())     return res.status(400).json({ error: 'SSH host is required' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'SSH username is required' });
  if (!privateKey && !password)  return res.status(400).json({ error: 'A private key or password is required' });

  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.sshHost       = host.trim();
  user.sshPort       = Number(port) || 22;
  user.sshUsername   = username.trim();
  user.sshDeployRoot = deployRoot ? deployRoot.trim() : '/opt/apps';

  // Store whichever auth method was provided (key takes precedence)
  if (privateKey && privateKey.trim()) {
    user.sshPrivateKey = crypto.encrypt(privateKey.trim());
    user.sshPassword   = ''; // clear the other method
  } else if (password && password.trim()) {
    user.sshPassword   = crypto.encrypt(password.trim());
    user.sshPrivateKey = '';
  }

  await user.save();
  res.json({ success: true, settings: user.toSafeJSON() });
}

async function deleteSshCredentials(req, res) {
  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.sshHost       = '';
  user.sshPort       = 22;
  user.sshUsername   = '';
  user.sshPrivateKey = '';
  user.sshPassword   = '';
  user.sshDeployRoot = '/opt/apps';
  await user.save();
  res.json({ success: true, settings: user.toSafeJSON() });
}

// ── GitHub token ──────────────────────────────────────────────────────────

async function saveGithubToken(req, res) {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'GitHub personal access token is required' });
  }

  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.githubToken = crypto.encrypt(token.trim());
  await user.save();
  res.json({ success: true, hasGithubToken: true });
}

async function deleteGithubToken(req, res) {
  const userId = req.session.userId || req.userId;
  const user   = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.githubToken = '';
  await user.save();
  res.json({ success: true, hasGithubToken: false });
}

module.exports = {
  getSettings,
  saveSshCredentials, deleteSshCredentials,
  saveGithubToken,    deleteGithubToken,
};
