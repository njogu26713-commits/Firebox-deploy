const mongoose = require('mongoose');

const UserWorkspaceSchema = new mongoose.Schema(
  {
    sessionKey: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, default: 'User workspace', trim: true, maxlength: 120 },
    githubUsername: { type: String, default: '', trim: true, maxlength: 120 },
    githubToken: { type: String, default: '' },
    githubConnectedAt: { type: Date },
    githubAuthMethod: { type: String, enum: ['oauth', 'pat'], default: 'pat' },
    projects: [{
      name: { type: String, required: true, trim: true, maxlength: 120 },
      repoUrl: { type: String, required: true, trim: true, maxlength: 500 },
      branch: { type: String, default: 'main', trim: true, maxlength: 120 },
      provider: { type: String, enum: ['railway', 'vercel', 'heroku', 'render'], default: 'railway' },
      sourceType: { type: String, enum: ['github', 'upload'], default: 'github' },
      uploadedFileCount: { type: Number, default: 0 },
      uploadPath: { type: String, default: '' },
      deploymentProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
      lastDeploymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deployment' },
      createdAt: { type: Date, default: Date.now },
    }],
    activity: [{
      projectName: { type: String, required: true, trim: true, maxlength: 120 },
      provider: { type: String, required: true, trim: true, maxlength: 30 },
      status: { type: String, default: 'requested', trim: true, maxlength: 30 },
      createdAt: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserWorkspace', UserWorkspaceSchema);
