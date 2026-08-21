require('dotenv').config();

module.exports = {
  port:      process.env.PORT      || 5000,
  nodeEnv:   process.env.NODE_ENV  || 'development',

  mongoUri:  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/firebox_deploy',

  sessionSecret: process.env.SESSION_SECRET || 'firebox_dev_secret_change_me',
  jwtSecret:     process.env.JWT_SECRET     || 'firebox_jwt_dev_secret_change_me',

  adminEmail:    process.env.ADMIN_EMAIL    || 'admin@firebox.local',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',

  // Temporary development-only switch. Keep false in any internet-facing deployment.
  authDisabled: process.env.DISABLE_AUTH === 'true',

  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },
};
