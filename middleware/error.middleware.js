const fs = require('fs');
const path = require('path');

const errorLogPath = path.join(__dirname, '..', 'logs', 'error.log');

function notFound(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'views', '404.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
}

function errorHandler(err, req, res, next) {
  const message = err.message || 'Internal server error';
  const status = err.status || 500;

  const line = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status} ${message}\n${err.stack || ''}\n\n`;
  fs.appendFile(errorLogPath, line, () => {});

  console.error(`[error] ${req.method} ${req.originalUrl}:`, message);

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message });
  }
  res.status(status).send(`<h1>${status}</h1><p>${message}</p><a href="/dashboard">Back to dashboard</a>`);
}

module.exports = { notFound, errorHandler };
