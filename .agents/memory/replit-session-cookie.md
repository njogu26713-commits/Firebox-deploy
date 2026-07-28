---
name: Replit session cookie fix
description: Session cookies silently fail in Replit's iframe preview without sameSite:none and trust proxy.
---

# Replit session cookie in iframe preview

## Rule
Any Express app using session cookies on Replit must set:
1. `app.set('trust proxy', 1)` — Express sees HTTP but the client connects via HTTPS through Replit's proxy
2. `cookie.secure: true` + `cookie.sameSite: 'none'` — Replit's preview is an iframe embedded on a different origin; browsers block cookies unless sameSite is explicitly `none`

**Why:** Replit's workspace preview embeds the app in an `iframe` hosted at `*.replit.dev/__replco/workspace_iframe.html`. This is a cross-site context. Browsers (Chrome 80+) apply `SameSite=Lax` by default, blocking cookies in cross-site iframes. Without `sameSite: none`, the session cookie is set on login but never sent on subsequent requests — the server creates a new empty session every time, causing auth middleware to redirect back to `/login`.

**How to apply:** In `server.js` (or wherever `express-session` is configured):
```js
app.set('trust proxy', 1);
// ...
session({
  cookie: {
    secure: true,
    sameSite: 'none',
    // ...
  }
})
```
