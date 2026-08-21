const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 15000;

function getConfig() {
  const baseUrl = String(process.env.FIREBOX_AZURE_AGENT_URL || '').trim().replace(/\/$/, '');
  const secret = String(process.env.FIREBOX_AZURE_AGENT_SECRET || '').trim();
  if (!baseUrl || !secret) {
    const error = new Error('Azure Agent is not configured. Set FIREBOX_AZURE_AGENT_URL and FIREBOX_AZURE_AGENT_SECRET.');
    error.code = 'AZURE_AGENT_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  let parsed;
  try { parsed = new URL(baseUrl); } catch {
    const error = new Error('FIREBOX_AZURE_AGENT_URL must be a valid URL.');
    error.code = 'AZURE_AGENT_INVALID_URL';
    error.statusCode = 503;
    throw error;
  }
  if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    const error = new Error('FIREBOX_AZURE_AGENT_URL must use HTTPS in production.');
    error.code = 'AZURE_AGENT_INSECURE_URL';
    error.statusCode = 503;
    throw error;
  }
  return { baseUrl, secret };
}

function normalizeError(error, operation) {
  if (error?.code === 'AZURE_AGENT_NOT_CONFIGURED' || error?.code === 'AZURE_AGENT_INVALID_URL' || error?.code === 'AZURE_AGENT_INSECURE_URL') return error;
  const status = error?.response?.status;
  const remoteMessage = typeof error?.response?.data?.error === 'string' ? error.response.data.error : '';
  const safeOperation = String(operation || 'request');
  const normalized = new Error(
    status === 401 || status === 403 ? `Azure Agent authentication failed during ${safeOperation}.` :
    status === 404 ? `Azure Agent endpoint was not found during ${safeOperation}.` :
    status === 400 || status === 422 ? `Azure Agent rejected the ${safeOperation} request${remoteMessage ? `: ${remoteMessage}` : '.'}` :
    status === 429 ? `Azure Agent rate limit reached during ${safeOperation}. Try again shortly.` :
    status >= 500 ? `Azure Agent returned a server error during ${safeOperation}.` :
    error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '') ? `Azure Agent request timed out during ${safeOperation}.` :
    `Azure Agent is unavailable during ${safeOperation}.`);
  normalized.code = status ? `AZURE_AGENT_HTTP_${status}` : (error?.code || 'AZURE_AGENT_UNAVAILABLE');
  normalized.statusCode = status === 401 || status === 403 ? 502 : status === 400 || status === 422 ? 400 : status === 404 ? 502 : status === 429 ? 503 : 502;
  normalized.cause = error;
  return normalized;
}

function createClient() {
  const { baseUrl, secret } = getConfig();
  const client = axios.create({
    baseURL: baseUrl,
    timeout: Number(process.env.FIREBOX_AZURE_AGENT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return client;
}

async function request(operation, method, path, options = {}) {
  try {
    const response = await createClient().request({ method, url: path, ...options });
    if (!response.data || typeof response.data !== 'object') throw new Error('Azure Agent returned a malformed response.');
    return response.data;
  } catch (error) {
    throw normalizeError(error, operation);
  }
}

async function health() {
  const result = await request('health check', 'GET', '/health');
  if (result.success !== true || result.service !== 'firebox-azure-agent') {
    const error = new Error('Azure Agent returned an unexpected health response.');
    error.code = 'AZURE_AGENT_MALFORMED_HEALTH';
    error.statusCode = 502;
    throw error;
  }
  return result;
}

const encode = (value) => encodeURIComponent(String(value));

module.exports = {
  health,
  createProject: (projectId) => request('project creation', 'POST', '/api/projects', { data: { projectId } }),
  listFiles: (projectId, path = '.') => request('file listing', 'GET', `/api/projects/${encode(projectId)}/files/list`, { params: { path } }),
  readFile: (projectId, path) => request('file read', 'POST', `/api/projects/${encode(projectId)}/files/read`, { data: { path } }),
  writeFile: (projectId, path, content) => request('file write', 'POST', `/api/projects/${encode(projectId)}/files/write`, { data: { path, content } }),
  makeDirectory: (projectId, path) => request('directory creation', 'POST', `/api/projects/${encode(projectId)}/files/mkdir`, { data: { path } }),
  build: (projectId, options = {}) => request('project build', 'POST', `/api/projects/${encode(projectId)}/build`, { data: options }),
  deploy: (projectId, options = {}) => request('project deployment', 'POST', `/api/projects/${encode(projectId)}/deploy`, { data: options }),
  jobStatus: (jobId) => request('job status', 'GET', `/api/jobs/${encode(jobId)}`),
  jobLogs: (jobId) => request('job logs', 'GET', `/api/jobs/${encode(jobId)}/logs`),
  getConfigStatus: () => {
    try { getConfig(); return { configured: true }; } catch (error) { return { configured: false, code: error.code, message: error.message }; }
  },
};
