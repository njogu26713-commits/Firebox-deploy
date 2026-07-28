# 🔥 Firebox Deploy

A self-hosted deployment platform for your own Node.js apps, APIs, websites,
and bots — a simplified, private Railway/Vercel built for the Firebox
ecosystem. One dashboard to connect a repo, deploy it into a Docker
container, route it through Nginx, and issue it an SSL certificate.

## Stack

- **Frontend:** plain HTML / CSS / JavaScript (no framework), Socket.IO client for live logs
- **Backend:** Node.js + Express
- **Database:** MongoDB (Mongoose)
- **Containers:** Docker (built and run via the Docker CLI)
- **Reverse proxy:** Nginx (auto-configured per project)
- **Process manager:** PM2 (optional fallback for non-containerized scripts)
- **SSL:** Let's Encrypt via certbot
- **Realtime:** Socket.IO for live deployment logs and status
- **Source control:** GitHub API + manual Git URL support

## Requirements on the host

- Node.js 18+
- MongoDB running and reachable (`MONGO_URI`)
- Docker installed and the app has access to `/var/run/docker.sock`
- Nginx installed, with a writable `sites-enabled` directory
- certbot installed (with the nginx plugin), if you want automatic SSL
- A wildcard or per-app DNS record pointing at this host, if using subdomains

## Getting started

```bash
git clone <this-repo> firebox-deploy
cd firebox-deploy
cp .env.example .env    # then edit .env with real values
npm install
npm run seed:admin      # creates the admin login from ADMIN_EMAIL / ADMIN_PASSWORD in .env
npm start                # runs server.js on PORT (default 4000)
```

Then open `http://localhost:4000/login` and sign in.

### Running the platform itself in Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

This mounts the host's Docker socket, Nginx `sites-enabled` directory, and
`/etc/letsencrypt`, so the platform container can manage sibling containers,
write Nginx configs, and read/renew certificates on the host.

## How a deployment works

Clicking **Deploy** (or pushing to the watched branch, if a GitHub webhook is
configured) runs the pipeline in `services/deploy.service.js`:

1. **Clone repository** — shallow clone of the configured branch into `APPS_ROOT/<slug>`
2. **Detect Node.js project** — verifies `package.json` exists at the configured root directory
3. **Detect package manager** — uses `pnpm` when `pnpm-lock.yaml` exists, `yarn` when `yarn.lock` exists, and `npm` otherwise; Corepack is enabled automatically for pnpm
4. **Build Docker image** — generates a `Dockerfile` from `docker/Dockerfile.node` if the repo doesn't ship its own, then runs `docker build`
5. **Start Docker container** — runs the image with the project's env vars, mapped to a stable host port on the `firebox_net` Docker network
6. **Configure Nginx automatically** — writes a reverse-proxy server block for the project's subdomain/custom domain and reloads Nginx
7. **Generate SSL certificate** — requests a Let's Encrypt cert via certbot's Nginx plugin
8. **Launch the app** — marks the project `running` and broadcasts the live status to the dashboard over Socket.IO

Every step streams timestamped log lines to the project's deploy log in
real time, and is recorded permanently on the `Deployment` document for
deployment history.

## Project structure

```
server.js                 ← application entry point
package.json               "start": "node server.js"

/config     → env + MongoDB connection
/models     → User, Project, Deployment (Mongoose schemas)
/routes     → Express route definitions (auth, projects, deployments, docker, logs, dashboard)
/controllers→ request handlers backing the routes above
/middleware → auth guards + centralized error handling
/services   → github, docker, nginx, ssl, pm2, deploy (pipeline), logger (Socket.IO)
/docker     → Dockerfile templates + docker-compose.yml for the platform itself
/scripts    → standalone shell scripts mirroring the pipeline, + admin seed script
/views      → server-rendered dashboard pages (login, dashboard, new project, project detail, 404)
/public     → static CSS/JS for the dashboard UI
/logs       → app.log / error.log written at runtime
```

## Features

- Login dashboard (session + JWT auth)
- Projects grid with live status beacons (running / building / stopped / failed)
- Add New Project — GitHub repo picker or manual Git URL
- One-click Deploy / Redeploy
- Start, Stop, Restart, Delete
- Live deployment logs over Socket.IO, plus full deployment history
- Environment variable manager per project
- Docker container resource usage (CPU, memory) and disk usage overview
- Subdomain + custom domain support, with SSL status badge
- Bot deployment support (WhatsApp / Telegram / Discord), API, static website, and generic Node app project types
- GitHub push webhook for auto-redeploy (`POST /webhooks/github/:projectId`)

## Security notes

This platform is designed for a single owner managing their own projects —
it intentionally has no multi-tenant isolation beyond one admin account.
Before exposing it to the internet:

- Set strong, unique `SESSION_SECRET` and `JWT_SECRET` values
- Set `ENABLE_SSL=true` and run the dashboard itself behind HTTPS
- Restrict who can reach port `4000` (the dashboard) at the firewall level
- Rotate `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` periodically
