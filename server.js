require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const http = require('http');

const express    = require('express');
const cors       = require('cors');
const morgan     = require('morgan');
const cookieParser = require('cookie-parser');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const { Server: SocketIOServer } = require('socket.io');

const config = require('./config/config');
const User = require('./models/User');
const connectDB    = require('./config/db');
const loggerService = require('./services/logger.service');
const githubService = require('./services/github.service');
const deployService = require('./services/deploy.service');
const Project      = require('./models/Project');

const { notFound, errorHandler } = require('./middleware/error.middleware');

// ── Ensure runtime directories exist ──────────────────────────────────────
['logs'].forEach((dir) => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

// ── App + HTTP server + Socket.IO ──────────────────────────────────────────
const app    = express();
app.set('trust proxy', 1); // Replit / reverse-proxy: treat forwarded HTTPS as secure
const server = http.createServer(app);
const io     = new SocketIOServer(server, { cors: { origin: '*' } });
loggerService.attachIO(io);

// ── Core middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(cookieParser());

// GitHub webhooks need raw body for HMAC verification — register before JSON parser
app.post('/webhooks/github/:projectId', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-hub-signature-256'];
    const valid     = githubService.verifyWebhookSignature(signature, req.body);
    if (!valid) return res.status(401).json({ error: 'Invalid webhook signature' });

    const payload = JSON.parse(req.body.toString('utf8'));
    const project = await Project.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
    if (pushedBranch && pushedBranch !== project.githubBranch) {
      return res.json({ skipped: true, reason: `push to ${pushedBranch}, watching ${project.githubBranch}` });
    }

    res.json({ accepted: true });

    deployService.triggerDeploy(project, 'webhook').catch((err) =>
      console.error(`[webhook] deploy error for ${project.slug}:`, err.message)
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret:            config.sessionSecret,
  resave:            false,
  saveUninitialized: false,
  store:             MongoStore.create({ mongoUrl: config.mongoUri }),
  cookie: {
    maxAge:    1000 * 60 * 60 * 24 * 30,
    httpOnly:  true,
    secure:    true,
    sameSite:  'none',
  },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth.routes'));
app.use('/api/user-auth',    require('./routes/user-auth.routes'));
app.use('/api/projects',    require('./routes/projects.routes'));
app.use('/api/deployments', require('./routes/deployments.routes'));
app.use('/api/settings',    require('./routes/settings.routes'));
app.use('/api/github',      require('./routes/github.routes'));
app.use('/api/azure',       require('./routes/azure.routes'));
app.use('/api/user/workspace', require('./routes/user-workspace.routes'));
app.use('/api/deployment-requests', require('./routes/deployment-requests.routes'));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'firebox-deploy', version: '2.0' }));

// ── Page routes (must come last before error handlers) ─────────────────────
app.use('/', require('./routes/dashboard.routes'));

// ── Socket.IO ─────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const sessionData = socket.request.session || {};
  if (config.authDisabled || sessionData.userId || sessionData.userAccountId) return next();
  next(new Error('Authentication required'));
});

io.on('connection', (socket) => {
  socket.on('subscribe:deployment', async (id) => {
    const sessionData = socket.request.session || {};
    if (config.authDisabled || sessionData.userId) return socket.join(`deployment:${id}`);
    if (!sessionData.userAccountId) return;
    const UserWorkspace = require('./models/UserWorkspace');
    const workspace = await UserWorkspace.findOne({ sessionKey: `user:${sessionData.userAccountId}`, 'projects.lastDeploymentId': id }).lean().catch(() => null);
    if (workspace) socket.join(`deployment:${id}`);
  });
  socket.on('unsubscribe:deployment', (id) => socket.leave(`deployment:${id}`));
  socket.on('subscribe:dashboard', () => {
    const sessionData = socket.request.session || {};
    if (config.authDisabled || sessionData.userId) socket.join('dashboard');
  });
});

// ── Error handling ─────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Boot ───────────────────────────────────────────────────────────────────
async function ensureAdminAccount() {
  const email = config.adminEmail.toLowerCase().trim();
  let admin = await User.findOne({ email });
  if (!admin) {
    admin = await User.findOne({ role: 'owner' });
  }
  if (!admin) {
    await User.create({ name: 'Admin', email, password: config.adminPassword, role: 'owner' });
    console.log(`[auth] Created admin account for ${email}`);
  } else if (admin.email !== email) {
    admin.email = email;
    await admin.save();
    console.log(`[auth] Synced owner account email to ${email}`);
  }
}

async function start() {
  await connectDB();
  await ensureAdminAccount();
  const resumed = await deployService.resumePendingDeployments();
  if (resumed) console.log(`[deploy] Resumed ${resumed} pending deployment job${resumed === 1 ? '' : 's'}`);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`
🔥 Firebox Deploy v2 running on port ${config.port} (${config.nodeEnv})
   Dashboard: http://localhost:${config.port}/login
   Provider:  VPS / SSH + PM2
`);
  });
}

start();

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  (err) => console.error('[uncaughtException]',  err));

module.exports = { app, server, io };
