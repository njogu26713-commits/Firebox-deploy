# Firebox Deploy

A self-hosted deployment platform for Node.js apps, APIs, websites, and bots — a private Railway/Vercel for the Firebox ecosystem.

## Stack

- **Backend:** Node.js + Express
- **Database:** MongoDB (Mongoose) — hosted on MongoDB Atlas
- **Realtime:** Socket.IO (live deployment logs)
- **Auth:** Session-based (connect-mongo) + JWT
- **Frontend:** Plain HTML/CSS/JS, no frame

The app starts automatically via the **Start application** workflow (`node server.js`) on port 5000.

To create/reset the admin account:
```bash
npm run seed:admin
```

Then open `/login` and sign in with the email/password you set in `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Environment variables / secrets

| Key | Purpose |
|-----|---------|
| `MONGO_URI` | MongoDB Atlas connection string |
| `SESSION_SECRET` | Express session signing key |
| `JWT_SECRET` | JWT signing key |
| `ADMIN_EMAIL` | Dashboard admin login email |
| `ADMIN_PASSWORD` | Dashboard admin login password |
| `PORT` | Server port (set to 5000) |
| `NODE_ENV` | Environment (`production`) |
| `GITHUB_WEBHOOK_SECRET` | Optional — for GitHub push webhook verification |

## Important notes

- **Docker + Nginx are required for actual deployments.** The dashboard UI runs fine on Replit, but the deploy pipeline (building Docker images, configuring Nginx, issuing SSL certs) needs a VPS with Docker and Nginx installed.
- The platform is designed for a single admin owner — no multi-tenant isolation.

## User preferences

- Keep the existing project structure and stack — do not restructure or migrate.
