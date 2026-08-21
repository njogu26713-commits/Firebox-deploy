const test = require('node:test');
const assert = require('node:assert/strict');

function loadService(env) {
  for (const name of ['FIREBOX_AZURE_AGENT_URL', 'FIREBOX_AZURE_AGENT_SECRET', 'AZURE_AGENT_URL', 'AZURE_AGENT_SECRET', 'FIREBOX_AGENT_URL', 'FIREBOX_AGENT_SECRET', 'AGENT_URL', 'AGENT_SECRET']) delete process.env[name];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../services/azureAgent.service')];
  return require('../services/azureAgent.service');
}

test('accepts exact Azure Agent variables', () => {
  const service = loadService({ FIREBOX_AZURE_AGENT_URL: 'https://agent.firebox.live', FIREBOX_AZURE_AGENT_SECRET: 'test-secret' });
  assert.equal(service.getConfigStatus().configured, true);
});

test('accepts legacy Agent aliases and surrounding quotes', () => {
  const service = loadService({ AZURE_AGENT_URL: '"https://agent.firebox.live/"', FIREBOX_AGENT_SECRET: "'test-secret'" });
  const status = service.getConfigStatus();
  assert.equal(status.configured, true);
  assert.equal(status.urlSource, 'AZURE_AGENT_URL');
  assert.equal(status.secretSource, 'FIREBOX_AGENT_SECRET');
});

test('reports presence without exposing secret', () => {
  const service = loadService({ FIREBOX_AZURE_AGENT_URL: 'https://agent.firebox.live' });
  const status = service.getConfigStatus();
  assert.equal(status.configured, false);
  assert.equal(status.urlConfigured, true);
  assert.equal(status.secretConfigured, false);
  assert.equal(status.message.includes('test-secret'), false);
});
