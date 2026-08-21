const User   = require('../models/User');
const config = require('../config/config');
const crypto = require('../services/crypto.service');
const sshService = require('../services/ssh.service');
const net = require('net');
const dns = require('dns').promises;
const axios = require('axios');

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

async function testOutboundTcp(req, res) {
  const user = await getAdminUser(req);
  if (!user || !user.sshHost) return res.status(400).json({ error: 'Save the VPS host before testing outbound TCP connectivity.' });
  const host = user.sshHost;
  const port = Number(user.sshPort || 22);
  const startedAt = Date.now();
  let resolvedAddresses = [];
  try {
    resolvedAddresses = (await dns.lookup(host, { all: true })).map((entry) => `${entry.address}/${entry.family}`);
  } catch (err) {
    return res.status(502).json({ error: `DNS resolution from Railway failed for ${host}: ${err.code || err.message}`, status: 'failed', host, port });
  }
  const result = await new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port, family: 4, autoSelectFamily: false, timeout: 10000 });
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      const socketDetails = socket.remoteAddress ? {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
      } : {};
      socket.destroy();
      resolve({ ...payload, host, port, resolvedAddresses, ...socketDetails, elapsedMs: Date.now() - startedAt });
    };
    socket.once('connect', () => finish({ status: 'success', message: `TCP connection from Railway to ${host}:${port}: SUCCESS` }));
    socket.once('timeout', () => finish({ status: 'timeout', message: `TCP connection from Railway to ${host}:${port}: TIMEOUT after 10 seconds` }));
    socket.once('error', (err) => finish({ status: 'failed', message: `TCP connection from Railway to ${host}:${port}: FAILED (${err.code || err.message})` }));
  });
  if (result.status === 'success') return res.json(result);
  res.status(502).json({ ...result, error: result.message });
}

async function getOutboundIp(req, res) {
  try {
    const response = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
    const ip = String(response.data?.ip || '').trim();
    if (!/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(ip)) throw new Error('The public IP service returned an invalid IPv4 address.');
    res.json({ success: true, ip, message: `Railway outbound IPv4: ${ip}` });
  } catch (err) {
    res.status(502).json({ error: `Could not determine Railway outbound IP: ${err.message}` });
  }
}

async function saveSshCredentials(req, res) {
  const { host, port, username, privateKey, password, deployRoot } = req.body;

  if (!host || !host.trim())     return res.status(400).json({ error: 'SSH host is required' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'SSH username is required' });
  const user = await getAdminUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.sshHost       = host.trim();
  user.sshPort       = Number(port) || 22;
  user.sshUsername   = username.trim();
  user.sshDeployRoot = deployRoot ? deployRoot.trim() : '/opt/apps';

  // Store whichever auth method was provided (key takes precedence). If both
  // are blank and credentials already exist, preserve the encrypted secret.
  if (privateKey && privateKey.trim()) {
    user.sshPrivateKey = crypto.encrypt(privateKey.trim());
    user.sshPassword   = ''; // clear the other method
  } else if (password && password.trim()) {
    user.sshPassword   = crypto.encrypt(password.trim());
    user.sshPrivateKey = '';
  } else if (!user.sshPrivateKey && !user.sshPassword) {
    return res.status(400).json({ error: 'A private key or password is required for the first save.' });
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
  saveSshCredentials, testSshConnection, testOutboundTcp, getOutboundIp, deleteSshCredentials,
  saveGithubToken,    deleteGithubToken,
};
