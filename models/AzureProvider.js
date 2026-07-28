const mongoose = require('mongoose');

/**
 * Singleton document that stores encrypted Azure credentials and a cached token.
 * Only one document exists in the collection (the admin's Azure subscription).
 */
const AzureProviderSchema = new mongoose.Schema(
  {
    // Encrypted credential fields — each is stored as base64-encoded JSON: {iv, tag, data}
    clientId:       { type: String, default: '' },
    clientSecret:   { type: String, default: '' },
    tenantId:       { type: String, default: '' },
    subscriptionId: { type: String, default: '' },

    // Cached access token (encrypted at rest)
    cachedToken:      { type: String, default: '' },
    tokenExpiresAt:   { type: Date,   default: null },

    // Connection health
    status:      { type: String, enum: ['connected', 'failed', 'unconfigured'], default: 'unconfigured' },
    statusError:  { type: String, default: '' },
    lastVerified: { type: Date,   default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AzureProvider', AzureProviderSchema);
