---
name: deploy
description: >
  Deploy, manage, and delete apps on Azure — static HTML/JS apps and fullstack container apps (Node.js, Python, or any runtime with a Dockerfile + optional SQLite persistence).
  Triggers: "deploy my app", "publish my app", "deploy this to Azure",
  "re-deploy", "update my app", "delete my app", "remove my app",
  "list my apps", "show my apps", "app info", "app status",
  "rebuild dashboard", "fix dashboard".
  Handles authentication, first deploys, re-deploys, and app management
  via MCP tools backed by Azure Static Web Apps and Azure Container Apps.
---

# Deploy Skill

You are orchestrating deployments to Azure. Static apps go to Azure Static Web Apps. Fullstack apps (any runtime + optional SQLite) go to Azure Container Apps.
Apps get custom domains under `*.env.fidoo.cloud` and Entra ID authentication.

**CRITICAL: No local tools required.** The user does NOT need Docker, Azure CLI (`az`), or any other tool installed locally. All deployment operations (ACR image builds, container management, blob storage) are handled remotely through MCP tools. Never instruct the user to install prerequisites.

## Step 1: Check Authentication

Before any operation, check if the user is authenticated:

1. Call `auth_status` (no arguments)
2. If `status` is `"authenticated"` — proceed to the requested operation
3. If `status` is `"not_authenticated"` or `"expired"` — run the login flow:
   a. Call `auth_login` — returns `verification_uri` and `user_code`
   b. Tell the user: **"Open {verification_uri} and enter code {user_code}"**
   c. Wait for the user to confirm they completed the login
   d. Call `auth_poll` with the `device_code` from step (a)
   e. Verify the response shows `status: "authenticated"`

## Step 2: Determine the Operation

Based on the user's request:

| User intent | Operation |
|---|---|
| "deploy", "publish", "put online" | **Deploy** (see Step 3) |
| "delete", "remove", "take down" | **Delete** (see Step 4) |
| "list", "show apps", "what's deployed" | **List** (see Step 5) |
| "info", "status", "details" about a specific app | **Info** (see Step 6) |
| "rename", "update description", "change name" | **Update info** (see Step 7) |
| "rebuild dashboard", "fix dashboard" | **Dashboard rebuild** (see Step 8) |

## Step 3: Deploy

### Detect first deploy vs re-deploy

Check if the target folder contains a `.deploy.json` file.

- **Has `.deploy.json`** → This is a **re-deploy**. The tool reads it automatically.
- **No `.deploy.json`** → This is a **first deploy**. You need `app_name` and `app_description`.

### First deploy

1. Ask the user for an **app name** (human-readable, e.g. "Budget Tracker") and a **short description** if they haven't provided them
2. Call `app_deploy` with:
   - `folder`: absolute path to the app folder
   - `app_name`: the display name
   - `app_description`: short description for the dashboard
3. The tool handles everything: slug generation, collision check, SWA creation, ZIP upload, DNS, auth config, `.deploy.json`, and dashboard rebuild
4. Report the URL: `https://{slug}.env.fidoo.cloud`

## App Type Detection

Before calling any deploy tool, analyze the project folder:

### ⛔ Unsupported database check — do this first

If the project uses any database **other than SQLite**, stop immediately and tell the user:

> "This deploy plugin only supports **SQLite** as a database. Your app appears to use **{detected db}**, which is not supported. To deploy with this plugin, you'll need to rewrite the data layer to use SQLite instead. I can help you do that."

**Unsupported database signals:**

| Signal | Database |
|---|---|
| `pg`, `postgres`, `pg-promise`, `@prisma/client` with `provider = "postgresql"` | PostgreSQL |
| `mysql`, `mysql2`, `@prisma/client` with `provider = "mysql"` | MySQL |
| `mongodb`, `mongoose`, `@prisma/client` with `provider = "mongodb"` | MongoDB |
| `redis`, `ioredis` | Redis |
| `@google-cloud/firestore`, `firebase-admin` | Firestore |
| `mssql`, `tedious` | SQL Server |
| `cassandra-driver` | Cassandra |
| `DATABASE_URL` in `.env` starting with `postgres://`, `mysql://`, `mongodb://` | External DB |

Do NOT proceed to deploy. Offer to help rewrite the app to SQLite.

---

**SQLite signals** (any of these counts):
- `require("node:sqlite")` or `from "node:sqlite"` in any JS/TS file
- `better-sqlite3`, `sqlite3`, `sqlite`, `typeorm`, `prisma`, or `sequelize` in `package.json`
- `SQLAlchemy`, `peewee`, `tortoise-orm`, or `databases` in `requirements.txt`
- Any `.db` or `.sqlite` file at the project root

| Dockerfile? | SQLite signals? | Action |
|---|---|---|
| No | No | `index.html` at root → `app_deploy` (static) |
| No | Yes | → **scaffold deployment files first**, then `container_deploy persistent_storage: true` |
| No | No, but has `package.json` / `requirements.txt` / backend code | → **scaffold deployment files** (no Litestream), then `container_deploy persistent_storage: false` |
| Yes | No | → `container_deploy persistent_storage: false` |
| Yes | Yes | → `container_deploy persistent_storage: true` |

Always confirm with the user before deploying:
- Static: "I'll deploy this as a **static app**. Correct?"
- Container: "I'll deploy this as a **container app**. Correct?"
- Fullstack + storage: "I'll deploy this as a **fullstack container with persistent storage** — SQLite detected. Correct?"

## Scaffold Deployment Files

When there is no Dockerfile, generate it before deploying. Write the files directly into the project folder. Show the user what you generated and confirm before deploying.

### Detect runtime

- Has `package.json` → **Node.js**
- Has `requirements.txt` → **Python**
- Has `.py` files but no `requirements.txt` → **Python** (create a minimal `requirements.txt`)
- Unknown → ask the user

### Detect start command (Node.js)

Check `package.json` `scripts.start` field. If missing, look for `server.js`, `index.js`, `app.js` in that order. Default: `node server.js`.

### Detect start command (Python)

Look for `app.py`, `server.py`, `main.py` in that order. Default: `python app.py`.

---

### Dockerfile Rules

1. **Never use `-slim` or `-alpine` base images.** Slim images strip CA certificates, causing TLS failures (`x509: certificate signed by unknown authority`) for any outbound HTTPS call (Azure APIs, webhooks, OAuth, Litestream). Always use the full base image (`node:22`, `python:3.12`).
2. **Canonical DB path: `/data/app.db`.** Always set `ENV DATA_DIR=/data` and `ENV DB_PATH=/data/app.db` in SQLite Dockerfiles. Litestream reads `${DB_PATH}` — if unset, the container crashes (`database path or replica URL required`). The app must read from `process.env.DB_PATH`. No custom DB filenames — this prevents silent data loss from path mismatches between Litestream and the app.
3. **Backend serves frontend.** The container runs a single process that serves both the API and static frontend assets. There is no separate frontend server. The backend framework serves the built frontend in its idiomatic way (e.g., `express.static()` for Express, `app.mount("/", StaticFiles(...))` for FastAPI, Flask `static_folder`).
4. **Build the frontend inside the container.** The deploy tool uploads source files — never rely on a local `dist/` or `build/` being present. If the app has a frontend build step, use a multi-stage Docker build: the first stage installs all dependencies and runs the project's build script (`npm run build`, `npx vite build`, etc.), the second stage copies the output and installs only production dependencies.

### File: `Dockerfile` — Node.js (no SQLite)

```dockerfile
FROM node:22
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "<start-file>"]
```

### File: `Dockerfile` — Node.js, with SQLite (Litestream)

```dockerfile
FROM node:22
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && rm /tmp/litestream.tar.gz
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data
ENV DB_PATH=/data/app.db
RUN mkdir -p /data
COPY litestream.yml /etc/litestream.yml
COPY start.sh ./
RUN chmod +x start.sh
EXPOSE 8080
CMD ["./start.sh"]
```

### File: `Dockerfile` — Python (no SQLite)

```dockerfile
FROM python:3.12
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["python", "<start-file>"]
```

### File: `Dockerfile` — Python, with SQLite (Litestream)

```dockerfile
FROM python:3.12
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && rm /tmp/litestream.tar.gz
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV DATA_DIR=/data
ENV DB_PATH=/data/app.db
RUN mkdir -p /data
COPY litestream.yml /etc/litestream.yml
COPY start.sh ./
RUN chmod +x start.sh
EXPOSE 8080
CMD ["./start.sh"]
```

### Adding a frontend build step (multi-stage)

If the project has a frontend build step (Vite, webpack, Next.js, etc.), convert the Dockerfile to multi-stage. Prepend a build stage and adjust the production stage to copy from it:

```dockerfile
# --- Build stage ---
FROM node:22 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Production stage (same as the base template, but copies from build) ---
FROM node:22
WORKDIR /app
COPY --from=build /app .
RUN npm ci --omit=dev
# ... rest of template (Litestream, ENV, etc.) ...
```

Detect the need for this by checking:
- `vite`, `webpack`, `esbuild`, or `next` in `package.json` devDependencies
- `vite.config.*`, `webpack.config.*`, or `next.config.*` in the project
- Backend code serves static files from `dist/`, `build/`, or `public/`

Confirm the build command with the user (default: `npm run build`).

### File: `litestream.yml` — always the same

```yaml
dbs:
  - path: ${DB_PATH}
    replicas:
      - type: abs
        account-name: ${AZURE_STORAGE_ACCOUNT_NAME}
        account-key: ${AZURE_STORAGE_ACCOUNT_KEY}
        bucket: ${AZURE_STORAGE_CONTAINER}
        path: app.db
```

### File: `start.sh` — Node.js

```sh
#!/bin/sh
set -e
litestream restore -if-replica-exists -config /etc/litestream.yml "${DB_PATH}"
exec litestream replicate -exec "node <start-file>" -config /etc/litestream.yml
```

### File: `start.sh` — Python

```sh
#!/bin/sh
set -e
litestream restore -if-replica-exists -config /etc/litestream.yml "${DB_PATH}"
exec litestream replicate -exec "python <start-file>" -config /etc/litestream.yml
```

### App code contract — strict DB path

The deploy agent enforces a **canonical DB path**: `DB_PATH=/data/app.db`. This is set in the Dockerfile, container env vars, and litestream.yml. The app **must** read from `process.env.DB_PATH` — no custom DB filenames.

Required app code pattern:

```js
// Node.js — MUST use process.env.DB_PATH
const DB_PATH = process.env.DB_PATH || "/data/app.db";
```

```python
# Python — MUST use os.environ DB_PATH
import os
DB_PATH = os.environ.get("DB_PATH", "/data/app.db")
```

### Pre-deploy DB path validation

Before calling `container_deploy` with `persistent_storage: true`, scan the app code for hardcoded DB paths. This is a **blocking validation** — do not deploy until resolved.

**Step 1 — Search for DB path usage:**
- Grep for `DatabaseSync(`, `new Database(`, `sqlite3.connect(`, `sqlite3.open(`, `better-sqlite3`, `SQLAlchemy`
- Grep for `.db"`, `.db'`, `.sqlite"`, `.sqlite'` in JS/TS/Python files
- Check if `process.env.DB_PATH` or `os.environ.get("DB_PATH")` is used

**Step 2 — Evaluate:**
- If the app reads `process.env.DB_PATH` → proceed
- If the app hardcodes a DB filename (e.g. `"barometer.db"`, `"./data.db"`, `"myapp.sqlite"`) → **block and fix**

**Step 3 — Fix hardcoded paths:**
Tell the user: "Your app uses a hardcoded DB path `{detected_path}`. For deployment with Litestream, the app must read the DB path from the `DB_PATH` environment variable. I'll update it now."

Then replace the hardcoded path with `process.env.DB_PATH || "/data/app.db"` (Node.js) or `os.environ.get("DB_PATH", "/data/app.db")` (Python). Show the diff and confirm before deploying.

**Why this matters:** Litestream and the app must agree on the exact same file path. If the app writes to `barometer.db` but Litestream replicates `app.db`, data is silently lost.

### Detecting frontend build needs

Before scaffolding, check if the project has a frontend build step:
- Has `vite`, `webpack`, `esbuild`, or `next` in `package.json` devDependencies → needs frontend build
- Has `vite.config.*`, `webpack.config.*`, or `next.config.*` → needs frontend build
- Backend serves static files from `dist/`, `build/`, or `public/` → needs frontend build

If a frontend build is detected, use the "with frontend build" Dockerfile variant and confirm the build command with the user (default: `npx vite build`).

### Container Dockerfile troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `database path or replica URL required` | `DB_PATH` env var not set | Add `ENV DB_PATH=/data/app.db` to Dockerfile |
| `x509: certificate signed by unknown authority` | Base image missing CA certs (`-slim` or `-alpine` used) | Use full base image (`node:22`, `python:3.12`) |
| `ENOENT: no such file or directory, stat '.../dist/index.html'` | Frontend not built in container | Use multi-stage build with `RUN npm run build` |
| `redirect_uri_mismatch` or redirect to `localhost` after deploy | App has its own MSAL/auth (e.g. B2C) with localhost redirect URIs hardcoded for dev. Easy Auth and app-level auth collide — double login. | The app must disable its own MSAL auth when deployed behind Easy Auth. Read the authenticated user from the `X-MS-CLIENT-PRINCIPAL` header instead. If the app must keep its own auth, register the deployed URL as a redirect URI in the app's own AD/B2C app registration. |

**IMPORTANT: Docker and Azure CLI (`az`) are NEVER required for deployment.** The deploy agent handles everything through MCP tools — ACR image builds, container app creation, and all Azure operations happen remotely. Never tell the user to install Docker, `az`, or any other tool as a prerequisite for deploying.

**Optional local debugging (advanced users only):** If an ACR build fails and the user already has Docker installed, they can optionally test the Dockerfile locally with `docker build -t test-app .` and `docker run -p 8080:8080 test-app` for faster iteration. This is purely optional and never a requirement.

### Re-deploy

1. Call `app_deploy` with just `folder` (the absolute path)
2. The tool reads `.deploy.json` and re-deploys automatically
3. Report the updated URL

### Error handling

- **"Not authenticated"** → Run the login flow (Step 1)
- **"slug already exists"** → Ask the user to choose a different app name
- **"Folder does not exist"** → Verify the path with the user

## Step 4: Delete an App

1. Ask the user which app to delete (by slug). If unsure, list apps first (Step 5)
2. Confirm with the user: "Are you sure you want to delete **{app_name}** ({slug})? This cannot be undone."
3. Call `app_delete` with `app_slug`
4. The tool removes the SWA, DNS record, and rebuilds the dashboard

The dashboard app (`apps` slug) cannot be deleted.

## Step 5: List Apps

1. Call `app_list` (no arguments)
2. Present the results as a readable list with name, slug, URL, and last deploy time
3. If no apps exist, tell the user

## Step 6: App Info

1. Call `app_info` with `app_slug`
2. Present: name, description, URL, status, last deploy time
3. If not found, suggest listing apps to find the correct slug

## Step 7: Update App Info

1. Call `app_update_info` with `app_slug` and the fields to change (`app_name` and/or `app_description`)
2. This updates the dashboard display only — it does NOT re-deploy the app code

## Step 8: Dashboard Rebuild

1. Call `dashboard_rebuild` (no arguments)
2. This regenerates the dashboard at `https://apps.env.fidoo.cloud` from current Azure state
3. Use this if the dashboard is out of sync

## Troubleshooting Container Apps

All debugging uses `curl` with ARM REST APIs — no `az` CLI dependency. Read the ARM token from the token store:

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.deploy-agent/tokens.json'))['access_token'])")
SUB="<subscription-id>"
RG="<resource-group>"
```

### App not responding — quick health check

```bash
curl -s -o /dev/null -w "%{http_code}" https://{app-url}/
```

### Check Container App config and FQDN

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/containerApps/{slug}?api-version=2024-03-01" \
  | python3 -m json.tool
```

### Restart a Container App revision

```bash
# Get the active revision name
REVISION=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/containerApps/{slug}/revisions?api-version=2024-03-01" \
  | python3 -c "import json,sys; revs=json.load(sys.stdin)['value']; print(next(r['name'] for r in revs if r['properties'].get('active')))")

# Restart it (Content-Length: 0 is required)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Length: 0" \
  "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/containerApps/{slug}/revisions/$REVISION/restart?api-version=2024-03-01"
```

### Check ACR image tags

Uses ACR admin credentials (already in MCP config):

```bash
curl -s -u "{acr-admin-username}:{acr-admin-password}" \
  "https://{acr-login-server}/v2/{slug}/tags/list" | python3 -m json.tool
```

### Read ACR build logs

After a failed `container_deploy`, extract the run ID from the error message:

```bash
# Get the log download URL (Content-Length: 0 is required)
LOG_URL=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Length: 0" \
  "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.ContainerRegistry/registries/{acr-name}/runs/{run-id}/listLogSasUrl?api-version=2019-06-01-preview" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['logLink'])")

# Fetch the actual logs
curl -s "$LOG_URL"
```

### Container App runtime logs (Log Analytics)

Find the Log Analytics workspace name (query via ARM proxy — the `api.loganalytics.io` endpoint requires a different token scope):

```bash
WORKSPACE=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.OperationalInsights/workspaces?api-version=2022-10-01" \
  | python3 -c "import json,sys; ws=json.load(sys.stdin)['value']; print(ws[0]['name'])")
```

Then query the logs through the ARM proxy:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.OperationalInsights/workspaces/$WORKSPACE/api/query?api-version=2020-08-01" \
  -d '{"query": "ContainerAppConsoleLogs_CL | where ContainerAppName_s == \"{slug}\" | top 50 by TimeGenerated | project TimeGenerated, Log_s"}' \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for row in d['Tables'][0]['Rows']:
  print(row[0][:19], row[1].strip() if row[1] else '')
"
```

## Important Notes

- All apps are protected by Entra ID — only users with the `app_subscriber` role can access them
- The deploy tool automatically excludes sensitive files (.env, .git, node_modules, .pem, .key, etc.)
- App slugs are generated from the app name (lowercase, alphanumeric + hyphens, max 60 chars)
- Each app gets a custom domain: `{slug}.env.fidoo.cloud`
- The dashboard at `apps.env.fidoo.cloud` is auto-rebuilt after every deploy, delete, or info update
