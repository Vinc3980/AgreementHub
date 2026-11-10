# Deploying AgreementHub

There are two different deployments in this repository:

| What | Where it runs | What it needs |
| --- | --- | --- |
| **Public showcase** (`docs/`) | GitHub Pages, static | Nothing. Push to `main`. |
| **Full application** | A Node.js host | PostgreSQL, persistent storage, Chromium, SMTP |

The live showcase is at **<https://vinc3980.github.io/AgreementHub/>**. GitHub Pages
cannot host the API, the database, authentication, or PDF generation — those require a
real server.

---

## 1. Public showcase (GitHub Pages)

The site in `docs/` is published directly from the `main` branch:

- GitHub → **Settings → Pages → Build and deployment**
  - Source: **Deploy from a branch**
  - Branch: **main**, folder: **/docs**
- Edit `docs/index.html` (and `docs/assets/`), commit, push. Pages redeploys in about a
  minute; no build step and no workflow are required.
- Keep asset paths **relative** (`assets/screens/desk.png`), because a project site is
  served from `https://<user>.github.io/AgreementHub/`, not from the domain root.
- Screenshots in `docs/assets/screens/` are real captures of the running application.

To preview locally, open `docs/index.html` in a browser or run any static server from
`docs/`.

---

## 2. Full application

### Requirements

- **Node.js** ≥ 20 (tested on 24) and npm ≥ 10
- **PostgreSQL** ≥ 14 (tested on 17)
- **Chrome / Chromium / Edge** for the PDF pipeline (`puppeteer-core`), or set
  `PDF_BROWSER_PATH` to a specific executable
- A **persistent disk** for `STORAGE_DIR` (final PDFs are write-once and re-hashed on
  every download)
- **SMTP** (or Resend) credentials for real email; the default `console` transport only
  logs
- A TLS reverse proxy in front of the web app

> Finalisation generates the final PDF inside the same transaction. If no browser is
> available the document does not finalise, so install Chromium (or run with a browser
> path) before enabling signing in production.

### Production environment

Start from `.env.example` and change at least:

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgres://user:pass@db-host:5432/agreementhub` |
| `HOST` / `PORT` | `127.0.0.1` / `3000` (API behind the proxy) |
| `WEB_BASE_URL` | `https://agreements.example.com` (used in verification, reset, invitation, QR links) |
| `WEB_ORIGIN` | `https://agreements.example.com` (CORS/CSRF allowlist) |
| `PUBLIC_BASE_URL` | `https://agreements.example.com` (legacy alias) |
| `TRUST_PROXY` | `true` (only when actually behind a reverse proxy) |
| `RATE_LIMIT_MAX` | `300` (or your budget) |
| `AUTH_RATE_LIMIT_MAX` | `20` |
| `EMAIL_TRANSPORT` | `smtp` (or `MAIL_PROVIDER=resend`) |
| `EMAIL_FROM` | `AgreementHub <no-reply@your-domain>` |
| `EMAIL_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | your SMTP provider |
| `STORAGE_DIR` | `/var/lib/agreementhub/storage` |
| `PDF_GENERATION` | `on` |
| `PDF_BROWSER_PATH` | `/usr/bin/chromium` (if auto-detection fails) |
| `AI_PROVIDER` | `rules` (offline) or `openai` + `OPENAI_API_KEY` |
| `PLATFORM_ADMIN_EMAILS` | empty in production; grant admin via the DB flag |
| `SCHEDULER_INTERVAL_MS` | `300000` |

The API loads `.env` from the working directory and the repository root; real process
environment variables take precedence.

### Single VPS (Ubuntu, recommended)

```bash
# 1. Packages
sudo apt update
sudo apt install -y postgresql chromium
# Install Node.js 20+ from NodeSource if your distro package is older.

# 2. Database
sudo -u postgres psql -c "CREATE ROLE agreementhub LOGIN PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE agreementhub OWNER agreementhub;"

# 3. Code and dependencies (keep devDependencies: the API runs through tsx)
sudo git clone https://github.com/Vinc3980/AgreementHub.git /srv/agreementhub
cd /srv/agreementhub
npm ci
cp .env.example .env    # edit for production

# 4. Build, migrate, seed
npm run build
npm run db:migrate
npm run db:seed
```

Run the two processes with systemd. The web app proxies `/api/*` to the API, so only the
web port needs to be exposed.

`/etc/systemd/system/agreementhub-api.service`:

```ini
[Unit]
Description=AgreementHub API
After=network.target postgresql.service

[Service]
User=agreementhub
WorkingDirectory=/srv/agreementhub
EnvironmentFile=/srv/agreementhub/.env
ExecStart=/usr/bin/npm run -w @agreementhub/api start
Restart=always

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/agreementhub-web.service`:

```ini
[Unit]
Description=AgreementHub web
After=network.target agreementhub-api.service

[Service]
User=agreementhub
WorkingDirectory=/srv/agreementhub
EnvironmentFile=/srv/agreementhub/.env
Environment=API_ORIGIN=http://127.0.0.1:3000
ExecStart=/usr/bin/npm run -w @agreementhub/web start
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agreementhub-api agreementhub-web
```

Reverse proxy with automatic TLS (Caddy):

```caddyfile
agreements.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Check the API directly with `curl http://127.0.0.1:3000/health`, then open
`https://agreements.example.com`.

> **`API_ORIGIN` is read when the web app is built.** The default
> `http://127.0.0.1:3000` is correct when both processes share a host. If the API lives
> elsewhere, set `API_ORIGIN` in the build environment and rebuild the web app.

### Managed alternatives

- **Database:** any managed PostgreSQL (run `npm run db:migrate` once per release).
- **Web:** a Node host (Vercel works for the Next.js app, but the API must be reachable
  and `STORAGE_DIR` must be durable on the API side).
- **API:** a VM or container host that includes Chromium and a persistent disk. Serverless
  filesystems are ephemeral and will break the final-PDF pipeline.
- **Email:** SMTP or Resend. Configure SPF/DKIM for deliverability.
- **Scheduler:** safe to run on every API instance — ticks are serialised with a
  PostgreSQL advisory lock.

### Release checklist

- [ ] `DATABASE_URL` points at the production database; backups are configured
- [ ] `WEB_BASE_URL` / `WEB_ORIGIN` use the public HTTPS origin
- [ ] `TRUST_PROXY=true` and the proxy forwards `X-Forwarded-*`
- [ ] `STORAGE_DIR` is on durable, backed-up storage and not web-served
- [ ] Chromium is installed and `PDF_BROWSER_PATH` is correct
- [ ] SMTP/Resend credentials work and `EMAIL_FROM` uses a verified domain
- [ ] `npm run db:migrate` has run for the release
- [ ] `/health` returns `{"status":"ok"}`
- [ ] At least one administrator exists (`users.is_platform_admin`)
- [ ] A test agreement can be finalised and its verification link resolves
