const mongoose = require('mongoose');

const EnvVarSchema = new mongoose.Schema(
  {
    key:    { type: String, required: true },
    value:  { type: String, required: true },
    secret: { type: Boolean, default: false },
  },
  { _id: false }
);

const AzureAppSchema = new mongoose.Schema(
  {
    // Identity
    name:          { type: String, required: true, trim: true },
    resourceGroup: { type: String, required: true, trim: true },
    region:        { type: String, default: 'East US' },

    // App Service Plan
    planName: { type: String, default: '' },
    planSku:  { type: String, default: 'F1' }, // Free, B1, B2, P1v3, etc.

    // Runtime
    runtime:    { type: String, default: 'nodejs' }, // nodejs, python, php, java, go, dotnet
    runtimeVersion: { type: String, default: '' },

    // Source
    repoUrl:    { type: String, default: '' },
    branch:     { type: String, default: 'main' },
    rootDir:    { type: String, default: '.' },

    // Build
    buildCommand: { type: String, default: '' },
    startCommand: { type: String, default: '' },
    port:         { type: Number, default: 8080 },

    // Azure-assigned values
    azureAppId: { type: String, default: '' },
    azureUrl:   { type: String, default: '' }, // *.azurewebsites.net
    customDomains: [{ type: String }],

    // Env vars
    envVars: { type: [EnvVarSchema], default: [] },

    // Status
    status: {
      type: String,
      enum: ['idle', 'building', 'deploying', 'running', 'stopped', 'failed'],
      default: 'idle',
    },

    lastDeployedAt: { type: Date },
    lastError:      { type: String, default: '' },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AzureApp', AzureAppSchema);
