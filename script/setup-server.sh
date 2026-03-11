#!/bin/bash
# One-time setup for draw.biswas.me on production server (31.97.102.48)
# Run as: ssh ubuntu@31.97.102.48 'bash -s' < script/setup-server.sh

set -e

echo "==> Creating Docker volume..."
docker volume create godraw-data || true

echo "==> Cloning repository..."
cd ~
if [ ! -d "go-draw" ]; then
  git clone git@github.com:anchoo2kewl/go-draw.git
fi

echo "==> Creating nginx config..."
sudo tee /etc/nginx/sites-available/draw.biswas.me > /dev/null <<'NGINX'
server {
    listen 80;
    server_name draw.biswas.me;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name draw.biswas.me;

    ssl_certificate /etc/letsencrypt/live/draw.biswas.me/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/draw.biswas.me/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support for collaboration
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

echo "==> Enabling nginx site..."
sudo ln -sf /etc/nginx/sites-available/draw.biswas.me /etc/nginx/sites-enabled/

echo "==> Getting SSL certificate..."
sudo certbot certonly --nginx -d draw.biswas.me --non-interactive --agree-tos --email anshuman@biswas.me || {
    echo "Certbot failed - you may need to set up DNS first"
    echo "Add A record: draw.biswas.me -> 31.97.102.48"
}

echo "==> Reloading nginx..."
sudo nginx -t && sudo systemctl reload nginx

echo "==> Building and starting container..."
cd ~/go-draw
docker compose build
docker compose up -d

echo "==> Waiting for health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8090/health > /dev/null 2>&1; then
    echo "==> Health check passed! draw.biswas.me is live."
    exit 0
  fi
  sleep 1
done

echo "==> Health check timed out. Check: docker compose logs"
exit 1
