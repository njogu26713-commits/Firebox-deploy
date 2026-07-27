# Firebox Deploy

A self-hosted deployment platform for Node.js apps, APIs, and bots. Connects to your VPS via SSH, clones/pulls your GitHub repos, installs dependencies, builds, and manages processes with PM2 — all from one dashboard.

## Architecture

- **Frontend:** plain HTML / CSS / JavaScript (no framework), Socket.IO for live deployment logs
- **Backend:** Node.js + Express
- **Database:** MongoDB (Mongoose)
- **Deployment pipeline:** SSH (`ssh2`) → git clone/pull → lockfile-based package-manager install → build → PM2 start/restart
- **Realtime:** Socket.IO streams live log lines during deployment
- **Source control:** GitHub API + manual Git URL support

## Running locally / on Replit

Requires MongoDB. Set `MONGO_URI` in your environment (or a `.env` file), then:

```bash
npm install
npm run seed:admin      # create the admin login from ADMIN_EMAIL / ADMIN_PASSWORD
node server.js          # starts on PORT (default 5000)
```

Open `/login` and sign in.

## Deployment pipeline

Clicking ⚡ Deploy (or a GitHub push webhook) runs this pipeline on your VPS over SSH:

1. **SSH Connect** — opens a connection to the configured VPS
2. **Clone or Pull** — `git clone` on first deploy, `git pull` on subsequent ones
3. **Install & Build** — detects `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json` (in that order), enables Corepack for pnpm, installs dependencies, and runs the matching build script when present
4. **PM2 Start/Restart** — `pm2 restart <name>` or `pm2 start "<start command>" --name <name>`

Logs stream live to the dashboard via Socket.IO and are saved to the Deployment document for later retrieval.

## Key environment variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default 5000) |
| `MONGO_URI` | MongoDB connection string |
| `SESSION_SECRET` | Express session secret |
| `JWT_SECRET` | JWT signing secret |
| `ADMIN_EMAIL` | Admin login email |
| `ADMIN_PASSWORD` | Admin login password |
| `GITHUB_WEBHOOK_SECRET` | Validates incoming GitHub push webhooks |

## Project structure

```
server.js                  ← entry point
config/config.js           ← env config
models/                    ← User, Project, Deployment (Mongoose)
routes/                    ← Express route definitions
controllers/               ← request handlers
middleware/                ← auth guards + error handling
services/
  ssh.service.js           ← SSH connect/exec/writeFile (ssh2)
  deploy.service.js        ← SSH deployment pipeline
  github.service.js        ← GitHub API (repo list, webhooks, command detection)
  logger.service.js        ← Socket.IO log broadcast
  crypto.service.js        ← AES-256 encryption for stored credentials
views/                     ← HTML pages (login, dashboard, new-project, project-detail, settings)
public/                    ← static CSS + JS
scripts/                   ← admin seed script
```

## User preferences

- Keep Railway completely removed — all deployments are SSH + PM2 only
- Detect package managers from repository lockfiles; never assume npm when pnpm or Yarn is present
- SSH credentials (host, port, username, private key or password, deploy root) are stored per-user, AES-256 encrypted
- Projects can override deploy path and PM2 process name individually
