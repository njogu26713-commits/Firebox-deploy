const UserAccount = require('../models/UserAccount');

function requireUserAuth(req, res, next) {
  if (!req.session || !req.session.userAccountId) return res.status(401).json({ error: 'User account authentication required' });
  req.userAccountId = req.session.userAccountId;
  next();
}

function requireUserPageAuth(req, res, next) {
  if (!req.session || !req.session.userAccountId) return res.redirect('/user-login');
  next();
}

async function getCurrentUser(req) {
  if (!req.userAccountId) return null;
  return UserAccount.findById(req.userAccountId);
}

module.exports = { requireUserAuth, requireUserPageAuth, getCurrentUser };
