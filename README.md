# oliverbar.net — Pi chat backend

Self-hosted chat/DM backend for oliverbar.net, running on the Raspberry Pi in
SQLite. This is the **hybrid** setup: the write-heavy chat subsystem (global
chat, DMs, presence, accounts, blocks) lives here — no daily write quota,
unlike Cloudflare KV — while the lightweight site config, pages, and games
stay on the Cloudflare Worker.

Routes and JSON shapes mirror the Worker's chat routes exactly, so the frontend
only needs its chat base URL pointed here.

## Run locally

```
npm install
cp .env.example .env      # edit EDIT_PASSWORD etc.
npm start
```

## Deploy on the Pi

```bash
# 1. Node 20 (Debian's apt Node is too old for some deps)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3

# 2. get the code
cd ~ && git clone https://github.com/skhshths/oliverbar.net-pi.git pi-api
cd ~/pi-api && npm install --omit=dev

# 3. configure
cp .env.example .env && nano .env     # set EDIT_PASSWORD to match the Worker

# 4. run as a service
sudo tee /etc/systemd/system/pi-api.service >/dev/null <<UNIT
[Unit]
Description=oliverbar.net chat backend
After=network.target
[Service]
Type=simple
User=oliverbarnet
WorkingDirectory=/home/oliverbarnet/pi-api
EnvironmentFile=/home/oliverbarnet/pi-api/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/oliverbarnet/pi-api
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now pi-api
```

## Expose through the existing tunnel

Add an ingress rule for `piapi.oliverbar.net → http://localhost:8081` to
`/etc/cloudflared/config.yml` (above the `http_status:404` catch-all), then
`cloudflared tunnel route dns pi-terminal piapi.oliverbar.net` and restart
cloudflared.

The server binds to `127.0.0.1` only — it is never directly reachable; the
tunnel is the sole way in, same as the terminal.
