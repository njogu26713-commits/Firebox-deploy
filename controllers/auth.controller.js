const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config/config');

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await user.comparePassword(password);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  user.lastLoginAt = new Date();
  await user.save();

  req.session.userId = user._id.toString();

  const token = jwt.sign({ id: user._id }, config.jwtSecret, { expiresIn: '30d' });

  res.json({ user: user.toSafeJSON(), token });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
}

async function me(req, res) {
  const userId = req.session.userId || req.userId;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: user.toSafeJSON() });
}

module.exports = { login, logout, me };
