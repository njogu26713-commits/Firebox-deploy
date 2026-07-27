const mongoose = require('mongoose');

const EnvVarSchema = new mongoose.Schema(
  {
    key:    { type: String, required: true },
    value:  { type: String, required: true },
    secret: { type: Boolean, default: false },
  },
  { _id: false }
);

const ProjectSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true, trim: true },
    slug:  { type: String, required: true, unique: true, lowercase: true, trim: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    type: {
      type: String,
      enum: ['api', 'website', 'bot-whatsapp', 'bot-telegram', 'bot-discord', 'node-app'],
      default: 'node-app',
    },

    // ── Source ───────────────────────────────────────────────────────────
    githubRepoFullName: { type: String, default: '' }, // "owner/repo"
    githubBranch:       { type: String, default: 'main' },
    repoUrl:            { type: String, required: true },

    // ── Build config ─────────────────────────────────────────────────────
    rootDirectory: { type: String, default: '.' },
    buildCommand:  { type: String, default: '' },
    startCommand:  { type: String, default: '' },

    // ── SSH / VPS deployment ──────────────────────────────────────────────
    // Full path on VPS (auto-derived from user.sshDeployRoot + slug if blank)
    deployPath: { type: String, default: '' },
    // PM2 process name (defaults to slug at deploy time)
    pm2Name:    { type: String, default: '' },
    // Public URL of the running app (set manually or after first deploy)
    vpsUrl:     { type: String, default: '' },

    // ── Status ───────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['idle', 'building', 'deploying', 'success', 'failed', 'crashed'],
      default: 'idle',
    },

    // ── Custom domain (manually configured) ──────────────────────────────
    customDomain: { type: String, default: '' },

    // ── Env vars (written to .env on VPS at deploy time) ─────────────────
    envVars: { type: [EnvVarSchema], default: [] },

    lastDeployedAt: { type: Date },

    // ── Last error message ────────────────────────────────────────────────
    setupError: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', ProjectSchema);
