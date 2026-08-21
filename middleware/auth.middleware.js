const jwt = require('jsonwebtoken');
const config = require('../config/config');

// Protects API routes — expects a valid session OR a Bearer JWT.
function requireAuth(req, res, next) {
  if (config.authDisabled) {
    // Temporary development bypass; never enable on an internet-facing instance.
    req.userId = req.session?.userId || 'dev-auth-disabled';
    return next();
  }
  if (req.session && req.session.userId) {
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      req.userId = decoded.id;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

// Protects server-rendered dashboard pages — redirects to /login instead of 401.
function requirePageAuth(req, res, next) {
  if (config.authDisabled) {
    // Give page handlers the session identity they normally receive after login.
    if (req.session && !req.session.userId) req.session.userId = 'dev-auth-disabled';
    return next();
  }
  if (req.session && req.session.userId) {
    return next();
  }
  return res.redirect('/login');
}

module.exports = { requireAuth, requirePageAuth };
