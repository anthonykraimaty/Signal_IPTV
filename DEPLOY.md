# Deployment

SIGNAL ships as a **single Docker container**: a multi-stage build compiles the
Vite/React frontend, then the Node backend serves the built UI + API + HLS on
one port (`4000`). FFmpeg (with `libx264`) is baked into the image. On every push
to `main`, a GitHub Actions workflow SSHes to the server, pulls the new code,
rebuilds the image (which re-builds the frontend), and restarts the container.

```
git push main ──▶ GitHub Actions ──ssh──▶ server: git pull + docker compose up -d --build
```

## 1. One-time server setup

On the server, as the `admin` user:

```bash
# Docker + compose plugin must be installed.
docker --version && docker compose version

# First deploy clones automatically, but you can pre-create the dir:
sudo mkdir -p /home/admin/signal-iptv && sudo chown "$USER" /home/admin/signal-iptv
```

The GitHub Actions deploy will `git clone` into `/home/admin/signal-iptv` on the
first run. After the first deploy, create the production env file **on the server**:

```bash
cd /home/admin/signal-iptv
cp .env.example .env
nano .env          # set ADMIN_PASSWORD, HOST_PORT, etc.
docker compose up -d --build
```

`.env` is git-ignored and never overwritten by deploys. The `signal-data` and
`signal-media` Docker volumes persist your users/credentials and HLS output
across rebuilds.

## 2. GitHub repository secrets

Add these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret      | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| `SSH_HOST`  | Server hostname or IP (e.g. `203.0.113.10`)                      |
| `SSH_USER`  | `admin`                                                          |
| `SSH_KEY`   | The **private** SSH key (full PEM, incl. BEGIN/END lines)        |
| `SSH_PORT`  | *(optional)* SSH port if not `22`                                |

Generate a deploy key pair (run locally), then authorize the public half on the server:

```bash
ssh-keygen -t ed25519 -f signal_deploy -N "" -C "github-actions-deploy"
# Paste signal_deploy.pub into the server's ~/.ssh/authorized_keys for `admin`:
ssh-copy-id -i signal_deploy.pub admin@SERVER     # or append it manually
# Put the PRIVATE key (contents of `signal_deploy`) into the SSH_KEY secret.
```

## 3. Deploy

Push to `main` (or trigger **Actions → Deploy → Run workflow** manually):

```bash
git push origin main
```

The workflow runs `docker compose up -d --build`, so the frontend is rebuilt and
served fresh on each deploy — no separate frontend refresh step needed.

## Local run (no Docker)

See [README.md](README.md) for the two-terminal dev workflow. To run the
container locally:

```bash
cp .env.example .env
docker compose up --build
# → http://localhost:4000
```
