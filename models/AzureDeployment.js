/**
 * AzureDeployment.js
 * Persists every FireboxDeploy-triggered Azure deployment with its full log,
 * failed step, and final status so users can review past deployments without
 * opening the Azure Portal.
 */

const mongoose = require('mongoose');

const LogEntrySchema = new mongoose.Schema(
  {
    level:   { type: String, default: 'info' },            // info | warn | error | success
    stream:  { type: String, default: 'info' },            // stdout | stderr | info | error
    step:    { type: String, default: '' },                // current pipeline step label
    message: { type: String, required: true },
    ts:      { type: Date,   default: () => new Date() },
  },
  { _id: false }
);

const AzureDeploymentSchema = new mongoose.Schema(
  {
    // Identity
    appName:       { type: String, required: true },
    resourceGroup: { type: String, required: true },
    azureApp:      { type: mongoose.Schema.Types.ObjectId, ref: 'AzureApp' },
    owner:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Source
    repoUrl: { type: String, default: '' },
    branch:  { type: String, default: 'main' },

    // Outcome
    status: {
      type:    String,
      enum:    ['running', 'success', 'failed'],
      default: 'running',
    },
    failedStep:    { type: String, default: '' },  // e.g. "Build", "Upload", "Startup"
    errorMessage:  { type: String, default: '' },  // full error text including Azure response
    deploymentId:  { type: String, default: '' },  // Kudu deployment ID
    kuduLog:       { type: String, default: '' },  // raw Kudu deployment log on failure
    url:           { type: String, default: '' },  // live app URL on success

    // Timing
    startedAt:   { type: Date, default: () => new Date() },
    completedAt: { type: Date },

    // Full log stream
    logs: { type: [LogEntrySchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AzureDeployment', AzureDeploymentSchema);
