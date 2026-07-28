const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'Admin' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['owner', 'admin'], default: 'owner' },

    // ── SSH / VPS credentials — stored AES-256 encrypted, never returned raw ──
    sshHost:       { type: String, default: '' },
    sshPort:       { type: Number, default: 22 },
    sshUsername:   { type: String, default: '' },
    sshPrivateKey: { type: String, default: '' }, // encrypted PEM
    sshPassword:   { type: String, default: '' }, // encrypted, alternative to key
    sshDeployRoot: { type: String, default: '/opt/apps' },

    // ── GitHub token — stored AES-256 encrypted ───────────────────────────────
    githubToken: { type: String, default: '' },

    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.toSafeJSON = function () {
  const hasSshCredentials = !!(
    this.sshHost &&
    this.sshUsername &&
    (this.sshPrivateKey || this.sshPassword)
  );
  return {
    id:              this._id,
    name:            this.name,
    email:           this.email,
    role:            this.role,
    lastLoginAt:     this.lastLoginAt,
    // SSH — return non-secret fields openly so the settings form can pre-fill them
    hasSshCredentials,
    sshHost:         this.sshHost         || '',
    sshPort:         this.sshPort         || 22,
    sshUsername:     this.sshUsername     || '',
    sshDeployRoot:   this.sshDeployRoot   || '/opt/apps',
    sshAuthType:     this.sshPrivateKey   ? 'key'
                   : this.sshPassword     ? 'password'
                   :                        'none',
    // GitHub
    hasGithubToken:  !!this.githubToken,
  };
};

module.exports = mongoose.model('User', UserSchema);
