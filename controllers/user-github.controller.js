const crypto = require('crypto');
const UserWorkspace = require('../models/UserWorkspace');
const config = require('../config/config');
const { encrypt } = require('../services/crypto.service');

function sessionKey(req) { return `user:${req.userAccountId}`; }

function oauthConfigured() {
  return !!(config.github.oauthClientId && config.github.oauthClientSecret && config.github.oauthCallbackUrl);
}

function startOAuth(req, res) {
  if (!oauthConfigured()) return res.status(503).json({ error: 'GitHub authorization is not configured yet. Use a personal access token or configure the GitHub OAuth app.' });
  const state = crypto.randomBytes(24).toString('hex');
  req.session.githubOAuthState = state;
  const params = new URLSearchParams({ client_id: config.github.oauthClientId, redirect_uri: config.github.oauthCallbackUrl, scope: 'repo read:user user:email', state });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
}

async function oauthCallback(req, res, next) {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.githubOAuthState) return res.status(400).send('Invalid GitHub authorization state. Please try again.');
    delete req.session.githubOAuthState;
    if (!oauthConfigured()) return res.status(503).send('GitHub authorization is not configured.');
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: config.github.oauthClientId, client_secret: config.github.oauthClientSecret, code: req.query.code, redirect_uri: config.github.oauthCallbackUrl }) });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return res.status(502).send('GitHub authorization did not return an access token.');
    const profileResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Firebox-Deploy' } });
    const profile = await profileResponse.json();
    await UserWorkspace.findOneAndUpdate({ sessionKey: sessionKey(req) }, { $set: { githubUsername: profile.login || 'GitHub user', githubToken: encrypt(tokenData.access_token), githubConnectedAt: new Date(), githubAuthMethod: 'oauth' }, $setOnInsert: { sessionKey: sessionKey(req) } }, { upsert: true, new: true });
    res.redirect('/user#source');
  } catch (err) { next(err); }
}

module.exports = { startOAuth, oauthCallback };
