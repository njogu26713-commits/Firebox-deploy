process.env.NODE_ENV = 'test';
process.env.FIREBOX_AZURE_AGENT_URL = 'https://agent.firebox.live';
process.env.FIREBOX_AZURE_AGENT_SECRET = 'test-secret-that-is-never-logged';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const azureAgent = require('../services/azureAgent.service');

const originalCreate = axios.create;

function mockRequest(handler) {
  const calls = [];
  axios.create = (options) => ({
    request: async (requestOptions) => {
      calls.push({ options, requestOptions });
      return handler(requestOptions, options);
    },
  });
  return calls;
}

test('Azure Agent client authenticates and normalizes common failures', async () => {
  const calls = mockRequest(async () => ({ data: { success: true, service: 'firebox-azure-agent', status: 'healthy' } }));
  const health = await azureAgent.health();
  assert.equal(health.service, 'firebox-azure-agent');
  assert.equal(calls[0].options.baseURL, 'https://agent.firebox.live');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret-that-is-never-logged');
  assert.equal(calls[0].requestOptions.url, '/health');

  axios.create = () => ({ request: async () => { throw { response: { status: 401, data: { error: 'Unauthorized' } } }; } });
  await assert.rejects(() => azureAgent.jobStatus('job_1'), /authentication failed/i);

  axios.create = () => ({ request: async () => { throw { code: 'ECONNABORTED', message: 'timeout' }; } });
  await assert.rejects(() => azureAgent.jobLogs('job_1'), /timed out/i);

  axios.create = () => ({ request: async () => ({ data: { success: false } }) });
  await assert.rejects(() => azureAgent.health(), /unexpected health response/i);

  const previousSecret = process.env.FIREBOX_AZURE_AGENT_SECRET;
  delete process.env.FIREBOX_AZURE_AGENT_SECRET;
  await assert.rejects(() => azureAgent.health(), (error) => error.code === 'AZURE_AGENT_NOT_CONFIGURED' && !error.message.includes(previousSecret));
  process.env.FIREBOX_AZURE_AGENT_SECRET = previousSecret;
  axios.create = originalCreate;
});
