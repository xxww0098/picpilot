# PicPilot + CLIProxyAPI (cliproxyapi) Deployment

**Important**: This repository now uses a **fully separated deployment architecture**.

- **picpilot** runs completely standalone (`caddy` + `auth` + `dockercopilot`).
- **cliproxyapi** (CLIProxyAPI) runs as an independent stack.
- PicPilot only talks to cliproxyapi via environment variables (`API_PROXY_URL`, `CLIPROXY_API_URL`). No service definition for cliproxyapi exists inside the picpilot compose.

This eliminates all previous problems with merged deploys: container name collisions (`cli-proxy-api` vs project-prefixed names), config/auth mixing, network pollution, and "配置老是出错".

## Recommended Production Layout

```text
/opt/
├── cliproxyapi/                 # Independent CLIProxyAPI stack
│   ├── compose.yml
│   ├── .env
│   ├── config.example.yaml      # Official upstream template (REQUIRED DEPENDENCY)
│   └── data/
│       ├── config/config.yaml   # Your customized copy of config.example.yaml
│       ├── auths/               # OAuth / account JSON files
│       ├── logs/
│       └── plugins/
│
└── picpilot/                    # Independent PicPilot stack
    ├── compose.yml
    ├── Caddyfile
    ├── .env
    └── data/
        ├── picpilot/            # DB, user data, etc.
        ├── cliproxyapi-logs/    # Optional read-only mount for debugging
        └── dockercopilot/
```

## Prerequisites

- Docker + Docker Compose v2+
- Real secrets (never commit them):
  - `DOCKERCOPILOT_SECRET`
  - `JWT_SECRET`
  - `ADMIN_USERS`
  - `CLIPROXY_MGMT_KEY` / `API_PROXY_API_KEY` (if using management features)
- Your account auth JSON files in `cliproxyapi/data/auths/`
- (Optional but recommended) Proper domains + email for Caddy HTTPS

## First-Time / Clean Deployment (Recommended)

From the source tree (`/root/picpilot`):

```bash
# 1. Prepare cliproxyapi (do this first)
mkdir -p /opt/cliproxyapi/data/{config,auths,logs,plugins}

cp deploy/cliproxyapi/compose.yml          /opt/cliproxyapi/compose.yml
cp deploy/cliproxyapi/.env.example         /opt/cliproxyapi/.env
cp deploy/cliproxyapi/config.example.yaml  /opt/cliproxyapi/config.example.yaml
cp deploy/cliproxyapi/config.yaml          /opt/cliproxyapi/data/config/config.yaml   # pre-customized version (recommended)
cp -r deploy/cliproxyapi/auths/*           /opt/cliproxyapi/data/auths/ 2>/dev/null || true

# Edit these with real values
# nano /opt/cliproxyapi/.env
# nano /opt/cliproxyapi/data/config/config.yaml   # at minimum set your providers + secret-key

# 2. Prepare picpilot
mkdir -p /opt/picpilot/data/{picpilot,cliproxyapi-logs,dockercopilot}

cp deploy/picpilot/compose.yml   /opt/picpilot/compose.yml
cp deploy/picpilot/Caddyfile     /opt/picpilot/Caddyfile
cp deploy/picpilot/.env.example  /opt/picpilot/.env

# Edit with real secrets. Make sure CLIPROXY_API_URL / API_PROXY_URL point at your cliproxyapi instance.
# nano /opt/picpilot/.env

# (Optional) Copy helper scripts
cp deploy/isolate-cliproxyapi.sh /opt/cliproxyapi/
cp deploy/update-cliproxyapi.sh  /opt/cliproxyapi/
```

### Start the stacks (order matters)

```bash
cd /opt/cliproxyapi
docker compose -p cliproxyapi up -d

cd /opt/picpilot
docker compose -p picpilot up -d --remove-orphans
```

### Verification

```bash
# External (cliproxyapi publishes its ports)
curl -s http://localhost:8317/v1/models | head -c 300

# Internal from PicPilot (requires network join or correct host in .env)
docker exec picpilot-auth-1 sh -c 'wget -qO- --timeout=5 http://cli-proxy-api:8317/v1/models | head -c 200' || \
  echo "Test via published port instead if the container image has no wget."

docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E 'picpilot|cliproxyapi'
```

## Cleaning Historical Remnants

Previous mixed deployments left behind:
- Old containers: `cli-proxy-api`, `picpilot-cliproxy-1`, `picpilot-frontend-1`
- Old networks: `cliproxy-net`, `picpilot_default`, `deploy_picpilot_net`, `caddy-net`
- Leftover scripts in `/opt/picpilot/` (old `update-cliproxy.sh`, `deploy.sh`, `.env.bak*`)

### One-shot cleanup (run the helper)

```bash
# From source
bash deploy/isolate-cliproxyapi.sh

# Or manually
docker rm -f cli-proxy-api picpilot-cliproxy-1 picpilot-frontend-1 2>/dev/null || true
docker network rm cliproxy-net deploy_picpilot_net picpilot_default caddy-net 2>/dev/null || true
rm -f /opt/picpilot/{deploy.sh,update-cliproxy.sh,.env.bak*}
```

After cleanup, re-run the `docker compose up` commands above.

## Daily Operations

**cliproxyapi only** (never touch picpilot):
```bash
cd /opt/cliproxyapi
docker compose pull
docker compose up -d
# or
bash update-cliproxyapi.sh
```

**PicPilot business logic** (auth/frontend):
```bash
cd /opt/picpilot
docker compose -p picpilot up -d --build auth
# or use the synced deploy.sh after you copy it from source
```

**Config changes** (especially providers in cliproxyapi):
1. Edit `/opt/cliproxyapi/data/config/config.yaml`
2. `cd /opt/cliproxyapi && docker compose -p cliproxyapi up -d`

**PicPilot secrets / Caddyfile changes**:
1. Edit the files in `/opt/picpilot/`
2. `cd /opt/picpilot && docker compose -p picpilot up -d`

## Critical: config.yaml (the main dependency)

`cliproxyapi` **requires** the official upstream configuration template.

- `config.example.yaml` in this repo is copied directly from https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml
- You **must** copy it to `data/config/config.yaml` and customize it (add your providers, keys, routing rules, etc.).
- The `config.yaml` shipped in `deploy/cliproxyapi/` is a ready-to-use version based on the example with our previous production values (secret-key, plugins, etc.) pre-applied.

Never run cliproxyapi without a properly filled `config.yaml`.

## Security & Best Practices

- Never commit real `.env` files or secrets.
- Use strong random values for `DOCKERCOPILOT_SECRET`, `JWT_SECRET`, and the management `secret-key` inside `config.yaml`.
- The management API is powerful — protect the secret key.
- For extra isolation you can run cliproxyapi on a different host/VM and only expose the necessary port(s) or use a reverse proxy in front.

## Rollback

- Keep old image tags.
- For picpilot: `PICPILOT_VERSION=old-version docker compose -p picpilot up -d --build auth`
- For cliproxyapi: `docker compose -p cliproxyapi up -d` after pulling a previous image tag (or keep the image ID).

## References

- `DEPLOY-STRUCTURE.md` — detailed architecture and rationale
- `isolate-cliproxyapi.sh` — one-command historical remnant cleaner + starter
- Upstream CLIProxyAPI docs for `config.yaml` fields

After any change to the files in `deploy/`, copy them back to the live `/opt/` locations and restart the affected stack.

This setup is designed to be maintainable, auditable, and free of the "合并部署" problems you experienced before.