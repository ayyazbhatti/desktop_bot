# Runbook: environment, local dev, production

This document is the **single checklist** for secrets, Vite + API, remote agents, TLS, and backups. Paths assume the repo root is `metatrader_bot`.

---

## 1. What must never be committed

These patterns are already **gitignored** (see root `.gitignore`):

| Item | Why |
|------|-----|
| `backend/data/` | Agent state, operators, pairs, worker config — **backup this directory** in production. |
| `.env`, `.env.local` | Secrets. |
| `desktop_agent/config.json` | Device token after pairing. |

Store production secrets in your host environment (systemd `EnvironmentFile`, Docker secrets, vault, etc.), not in the repo.

---

## 2. Backend environment (`backend/` or process manager)

Create **`backend/.env`** or export variables before `cargo run`. Reference: `backend/.env.example`.

| Variable | Required | Purpose |
|----------|----------|---------|
| `PORT` | No | API listen port; default **3001**. |
| `OPERATOR_JWT_SECRET` | If using operator login | **≥16 characters**. Signs HttpOnly cookie `mt5_operator`. |
| `OPERATOR_BOOTSTRAP_PASSWORD` | One-time only | If `backend/data/operators.json` **does not exist**, first start creates **`OPERATOR_BOOTSTRAP_ADMIN_USER`** (default `admin`). Remove from env after first boot. |
| `OPERATOR_BOOTSTRAP_ADMIN_USER` | No | Default `admin` when bootstrapping. |
| `CORS_ALLOWED_ORIGINS` | Yes, if operator login + browser | Comma-separated origins, e.g. `http://localhost:5173` (dev) or `https://panel.example.com` (prod). Needed for **cookies** (`allow_credentials`). |
| `PANEL_API_KEY` | No | Extra gate: `X-Panel-Api-Key` / Bearer / WebSocket `panel_key`. Optional if you rely only on operator JWT + network controls. |
| `AGENT_ADMIN_KEY` | Yes for remote agent **admin** APIs | Panel “Remote devices” and pairing; must match browser storage / `VITE_AGENT_ADMIN_KEY` in dev. You can also set the key from the UI (saved as `backend/data/agent_admin_key.txt`), which **overrides** this env on restart. |
| `AGENT_TOKEN_PEPPER` | No | Optional extra for hashed device tokens; set **before** pairing prod agents; changing it invalidates tokens. |
| `PYTHON_CMD` | No | e.g. `python` / `py -3`. |

**Operator auth is active** when `OPERATOR_JWT_SECRET` is set and `operators.json` has at least one user. Until then, only `PANEL_API_KEY` (if set) and public agent routes apply as documented in `IMPLEMENTATION-phase1-agent.md`.

---

## 3. Frontend dev (Vite) environment

File: **`frontend/.env.local`** (gitignored). `vite.config.ts` loads env for the **dev proxy** (not bundled unless prefixed with `VITE_`).

| Variable | Purpose |
|----------|---------|
| `API_PORT` or `VITE_API_PORT` | Backend port; default 3001. |
| `PANEL_API_KEY` | Same value as backend `PANEL_API_KEY`: Vite adds `X-Panel-Api-Key` to proxied `/api` and `/ws` so the browser does not need `VITE_PANEL_API_KEY`. |
| `VITE_AGENT_ADMIN_KEY` | Optional pre-fill for Remote devices page; must match backend `AGENT_ADMIN_KEY`. |

**Operator login + Vite:** set **`CORS_ALLOWED_ORIGINS=http://localhost:5173`** on the **API** so the session cookie works.

```powershell
# Example: from repo root — start API (loads backend/.env if you use a dotenv loader, or set vars in shell)
cd c:\xampp\htdocs\metatrader_bot
$env:OPERATOR_JWT_SECRET = "change-me-at-least-16-chars"
$env:CORS_ALLOWED_ORIGINS = "http://localhost:5173"
$env:AGENT_ADMIN_KEY = "your-agent-admin-secret"
cargo run --manifest-path backend/Cargo.toml

# Other terminal: frontend
cd frontend
npm run dev
```

Open `http://localhost:5173`. Sign in if operator auth is enabled; use **Remote devices** with the same `AGENT_ADMIN_KEY` as the server.

---

## 4. First operator account (bootstrap vs manual)

**A. Bootstrap (recommended for first machine)**  
1. Set `OPERATOR_JWT_SECRET` and `OPERATOR_BOOTSTRAP_PASSWORD`.  
2. Ensure **`backend/data/operators.json` does not exist** (folder may exist empty).  
3. Start API once → `operators.json` is created with admin.  
4. **Unset** `OPERATOR_BOOTSTRAP_PASSWORD` for subsequent runs.

**B. Manual / extra users**  
- Admin JWT: `POST /api/auth/users` with body `{ "username", "password", "role": "admin"|"viewer" }`.  
- Or edit `operators.json` only if you know how to produce Argon2 hashes (not recommended).

---

## 5. Remote agent pairing (summary)

1. API running with **`AGENT_ADMIN_KEY`** set.  
2. Panel **Remote devices**: enter admin key → **New pairing code**.  
3. On the PC with MetaTrader: `PAIRING_CODE` and API base URL in `desktop_agent` (see `desktop_agent/README.md` and `docs/IMPLEMENTATION-phase1-agent.md`).  
4. Device token is stored in **`desktop_agent/config.json`** (gitignored).

---

## 6. Production deploy (TLS + reverse proxy)

### 6.1 Build the static panel

```powershell
cd frontend
npm run build
```

Upload **`frontend/dist/`** to the path nginx serves as `root` (example: `/var/www/mt5-panel/dist`).

### 6.2 API on the server

- Run the Rust binary (or `cargo run --release`) bound to **127.0.0.1:3001** (or another loopback port); do **not** expose it publicly without TLS and auth in front.  
- Set the same env vars as §2, with **`CORS_ALLOWED_ORIGINS=https://your-panel-hostname`** only (no wildcard when using cookies).  
- Use strong random values for `OPERATOR_JWT_SECRET`, `AGENT_ADMIN_KEY`, and optional `PANEL_API_KEY`.

### 6.3 nginx

Start from **`deploy/nginx-mt5-panel.example.conf`**: replace `server_name`, TLS certificate paths, `root`, and upstream if the API port differs. Uncomment and configure `ssl_certificate` / `ssl_certificate_key` (e.g. Let’s Encrypt).

Optional: terminate **`PANEL_API_KEY`** at nginx with `proxy_set_header X-Panel-Api-Key ...` so the browser never holds it (then omit `PANEL_API_KEY` from the SPA build).

**HTTP → HTTPS:** add a separate `server { listen 80; return 301 https://$host$request_uri; }` for the same `server_name`.

### 6.4 Production SPA + API same host

If the browser uses **`https://panel.example.com`** for both `/` and `/api`, **no** `VITE_PANEL_API_KEY` is required in the built assets; cookies are same-site to the panel host. Ensure **`CORS_ALLOWED_ORIGINS`** includes exactly that origin (or rely on same-origin and still set the list to that one URL if the API validates CORS strictly).

---

## 7. Backups

**Directory**: `backend/data/` (entire folder).

Typical files:

- `operators.json` — operator accounts.  
- `agent_state.json` — devices, commands, remote worker config.  
- `position_pairs.json`, `exness_config.json`, `worker_config.json`, etc.

**Cadence:** copy or snapshot on a schedule (daily for active trading). Test restore on a non-production host.

`desktop_agent/config.json` on each PC should be backed up or recoverable via **re-pairing**.

---

## 8. Quick health checks

- `GET https://<panel>/api/health` — JSON with `ok`, `service`, `version`.  
- Panel loads, operator login works (if enabled).  
- Remote devices list updates after pairing; agent heartbeats if bridge is running.

---

## 9. Related files

- `backend/.env.example` — variable list.  
- `deploy/nginx-mt5-panel.example.conf` — TLS + `/api` + `/ws` proxy.  
- `docs/IMPLEMENTATION-phase1-agent.md` — agent API and env details.
