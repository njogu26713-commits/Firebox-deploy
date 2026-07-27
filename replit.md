# FireboxDeploy

A self-hosted deployment platform for the Firebox ecosystem — deploy and manage Node.js apps, websites, APIs, and bots from a single dashboard with first-class Azure App Service integration.

## Stack

- **Backend**: Node.js / Express
- **Database**: MongoDB (via Mongoose)
- **Auth**: Session-based (express-session + connect-mongo) + JWT
- **Real-time**: Socket.IO
- **Frontend**: Vanilla JS + HTML/CSS (no build step)

## Run

```
node server.js
```

Requires MongoDB. Set `MONGO_URI` in `.env` (copy from `.env.example`).

## Key environment variables

| Variable | Description |
|----------|-------------|
| `MONGO_URI` | MongoDB connection string |
| `SESSION_SECRET` | Session signing secret |
| `JWT_SECRET` | JWT signing secret |
| `PORT` | HTTP port (default 4000, Replit overrides to 5000) |
| `ADMIN_EMAIL` | Initial admin account email |
| `ADMIN_PASSWORD` | Initial admin account password |
| `GITHUB_WEBHOOK_SECRET` | Optional — HMAC secret for GitHub push webhooks |

## Seed admin account

```
npm run seed:admin
```

## Project structure

```
server.js              Entry point
config/                DB connection, app config
controllers/           Request handlers
routes/                Express routers
services/              Business logic (Azure, SSH, deploy, logger…)
models/                Mongoose schemas
views/                 HTML pages served by Express
public/                Static assets (CSS, JS)
middleware/            Auth, error handling
scripts/               One-off scripts (seed admin, deploy.sh)
```

## Features implemented

- **Azure App Service** — full CRUD: create/start/stop/restart/delete apps and resource groups
- **Environment Variables** — view and edit Azure App Settings per-app
- **Monitoring** — CPU, memory, request metrics via Azure Monitor
- **Deployment Logs** — deployment history with sub-log entries
- **Custom Domains** — add/remove hostnames on Azure apps
- **Cost Management** — monthly cost breakdown by resource type
- **Scaling** — adjust App Service Plan instance count
- **`fireboxdeploy.toml`** — auto-detect runtime, build/start commands from repo
- **SSH/VPS deployments** — deploy to any Linux server via SSH + PM2
- **GitHub webhooks** — trigger deploys on push

## User preferences

- Keep existing project structure — do not restructure or migrate
- No build tooling — frontend is plain HTML/CSS/JS
