// One-off script to create (or reset) the single admin/owner account used to
// log into the Firebox Deploy dashboard.
// Usage: npm run seed:admin

require('dotenv').config();
const connectDB = require('../config/db');
const config = require('../config/config');
const User = require('../models/User');

(async () => {
  await connectDB();

  const existing = await User.findOne({ email: config.adminEmail });
  if (existing) {
    existing.password = config.adminPassword;
    await existing.save();
    console.log(`✓ Password reset for existing admin: ${config.adminEmail}`);
  } else {
    await User.create({
      name: 'Admin',
      email: config.adminEmail,
      password: config.adminPassword,
      role: 'owner',
    });
    console.log(`✓ Admin account created: ${config.adminEmail}`);
  }

  console.log('You can now log in at /login with these credentials.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed to seed admin user:', err);
  process.exit(1);
});
