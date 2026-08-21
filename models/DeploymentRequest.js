const mongoose = require('mongoose');

const DeploymentRequestSchema = new mongoose.Schema(
  {
    requesterName: { type: String, required: true, trim: true, maxlength: 120 },
    requesterEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 180 },
    projectName: { type: String, required: true, trim: true, maxlength: 120 },
    provider: { type: String, enum: ['railway', 'vercel', 'heroku', 'render'], required: true },
    repoUrl: { type: String, required: true, trim: true, maxlength: 500 },
    branch: { type: String, default: 'main', trim: true, maxlength: 120 },
    notes: { type: String, default: '', trim: true, maxlength: 2000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'deployed'], default: 'pending' },
    adminNotes: { type: String, default: '', trim: true, maxlength: 2000 },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DeploymentRequest', DeploymentRequestSchema);
