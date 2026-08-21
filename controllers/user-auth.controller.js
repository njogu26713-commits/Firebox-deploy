const UserAccount = require('../models/UserAccount');

function safe(value, max) { return String(value || '').trim().slice(0, max); }

async function register(req, res, next) {
  try {
    const name = safe(req.body.name, 120);
    const email = safe(req.body.email, 180).toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (await UserAccount.findOne({ email })) return res.status(409).json({ error: 'An account with this email already exists.' });
    const account = await UserAccount.create({ name, email, password });
    req.session.userAccountId = account._id.toString();
    res.status(201).json({ user: account.toSafeJSON() });
  } catch (err) { next(err); }
}

async function login(req, res, next) {
  try {
    const email = safe(req.body.email, 180).toLowerCase();
    const password = String(req.body.password || '');
    const account = await UserAccount.findOne({ email });
    if (!account || !(await account.comparePassword(password))) return res.status(401).json({ error: 'Invalid email or password.' });
    account.lastLoginAt = new Date();
    await account.save();
    req.session.userAccountId = account._id.toString();
    res.json({ user: account.toSafeJSON() });
  } catch (err) { next(err); }
}

function logout(req, res) {
  if (req.session) delete req.session.userAccountId;
  res.json({ success: true });
}

async function me(req, res, next) {
  try {
    const account = await UserAccount.findById(req.session.userAccountId).lean();
    if (!account) return res.status(401).json({ error: 'User account authentication required' });
    res.json({ user: { id: account._id, name: account.name, email: account.email, lastLoginAt: account.lastLoginAt } });
  } catch (err) { next(err); }
}

module.exports = { register, login, logout, me };
