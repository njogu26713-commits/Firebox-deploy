const User   = require('../models/User');
const config = require('../config/config');
const crypto = require('../services/crypto.service');
const sshService = require('../services/ssh.service');

async function getAdminUser(req) {
  const sessionId = req.session?.userId || req.userId;
  if (sessionId && /^[a-f\d]{24}$/i.test(String(sessionId))) return User.findById(sessionId);
  return User.findOne({ $or: [{ email: config.adminEmail.toLowerCase() }, { role: 'owner' }] });
}

async function getSettings(req, res) {
  const user = await getAdminUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ settings: user.toSafeJSON() });
}

// ── SSH credentials ───────────────────────────────────────────────────────

async function testSshConnection(req, res) {
  const user = await getAdminUser(req);
  if (!user || !user.sshHost || !user.sshUsername) return res.status(400).json({ error: 'Save the VPS host and username before testing the connection.' });
  if (!user.sshPrivateKey && !user.sshPassword) return res.status(400).json({ error: 'Save an SSH private key or password before testing the connection.' });
  let conn;
  try {
    conn = await sshService.connect({
      host: user.sshHost,
      port: user.sshPort || 22,
      username: user.sshUsername,
      privateKey: user.sshPrivateKey ? crypto.decrypt(user.sshPrivateKey) : undefined,
      password: user.sshPassword ? crypto.decrypt(user.sshPassword) : undefined,
    });
    const result = await sshService.exec(conn, 'printf firebox-ssh-ok');
    if (result.code !== 0 || result.stdout.trim() !== 'firebox-ssh-ok') throw new Error('SSH command execution test failed.');
    res.json({ success: true, message: `SSH connection established to ${user.sshHost}:${user.sshPort || 22}.` });
  } catch (err) {
    const detail = String(err.message || err);
    const suffix = /handshake|timed out|timeout/i.test(detail) ? ' Check that the host is reachable, the SSH port is open, and the VPS firewall allows connections from the Firebox server.' : /authentication|auth|key|password/i.test(detail) ? ' Check the SSH username and private key or password.' : '';
    res.status(502).json({ error: `SSH connection failed: ${detail}.${suffix}` });
  } finally {
    if (conn) conn.end();
  }
}

async function saveSshCredentials(req, res) {
  const { host, port, username, privateKey, password, deployRoot } = req.body;

  if (!host || !host.trim())     return res.status(400).json({ error: 'SSH host is required' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'SSH username is required' });
  if (!privateKey && !password)  return res.status(400).json({ error: 'A private key or password is required' });

  const user = await getAdminUser(req);
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
  const user = await getAdminUser(req);
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

  const user = await getAdminUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.githubToken = crypto.encrypt(token.trim());
  await user.save();
  res.json({ success: true, hasGithubToken: true });
}

async function deleteGithubToken(req, res) {
  const user = await getAdminUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.githubToken = '';
  await user.save();
  res.json({ success: true, hasGithubToken: false });
}

module.exports = {
  getSettings,
  saveSshCredentials, testSshConnection, deleteSshCredentials,
  saveGithubToken,    deleteGithubToken,
};
