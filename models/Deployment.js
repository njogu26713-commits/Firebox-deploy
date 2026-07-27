const mongoose = require('mongoose');

const LogEntrySchema = new mongoose.Schema(
  {
    level:   { type: String, default: 'info' },
    message: { type: String, default: '' },
    ts:      { type: Date,   default: Date.now },
  },
  { _id: false }
);

const DeploymentSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },

    status: {
      type: String,
      enum: ['queued', 'building', 'deploying', 'success', 'failed', 'crashed', 'removed'],
      default: 'queued',
    },

    triggeredBy: { type: String, enum: ['manual', 'webhook', 'redeploy', 'rollback'], default: 'manual' },

    triggeredAt:  { type: Date, default: Date.now },
    completedAt:  { type: Date },

    // Public URL once the deployment is live (manually set or auto-filled from vpsUrl)
    url: { type: String, default: '' },

    // Full log captured during deployment (for "Fetch logs" retrieval)
    logs: { type: [LogEntrySchema], default: [] },

    // Extra metadata (commit SHA, message, etc. — populated by webhook trigger)
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

DeploymentSchema.index({ project: 1, createdAt: -1 });

module.exports = mongoose.model('Deployment', DeploymentSchema);
