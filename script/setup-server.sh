#!/bin/bash
# One-time setup for draw.biswas.me on production server (31.97.102.48)
# Run as: ssh ubuntu@31.97.102.48 'bash -s' < script/setup-server.sh
#
# Prerequisites:
# - DNS A record: draw.biswas.me -> 31.97.102.48 (Cloudflare, proxied)
# - GitHub deploy key with read access to go-draw repo

set -e

echo "==> Creating project directory structure..."
mkdir -p /home/ubuntu/go-draw

echo "==> Cloning repository..."
if [ ! -d "/home/ubuntu/go-draw/source" ]; then
  git clone git@github.com:anchoo2kewl/go-draw.git /home/ubuntu/go-draw/source
else
  echo "    (source directory already exists, skipping clone)"
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

    # Cloudflare Origin Certificate (SSL mode: Full Strict)
    ssl_certificate /etc/ssl/cloudflare/draw.biswas.me.pem;
    ssl_certificate_key /etc/ssl/cloudflare/draw.biswas.me.key;

    # Zero-downtime: friendly error page during deploys
    error_page 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
        internal;
    }

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

        # Zero-downtime: retry on upstream errors
        proxy_next_upstream error timeout http_502 http_503;
    }
}
NGINX

echo "==> Enabling nginx site..."
sudo ln -sf /etc/nginx/sites-available/draw.biswas.me /etc/nginx/sites-enabled/

echo "==> Setting up SSL certificate..."
# Since draw.biswas.me is behind Cloudflare proxy, use Cloudflare Origin Certificate
# 1. Generate at: Cloudflare Dashboard > SSL/TLS > Origin Server > Create Certificate
# 2. Save cert to /etc/ssl/cloudflare/draw.biswas.me.pem
# 3. Save key to /etc/ssl/cloudflare/draw.biswas.me.key
# 4. Set Cloudflare SSL mode to "Full (Strict)"

sudo mkdir -p /etc/ssl/cloudflare

if [ ! -f /etc/ssl/cloudflare/draw.biswas.me.pem ]; then
    echo "    WARNING: SSL certificate not found at /etc/ssl/cloudflare/draw.biswas.me.pem"
    echo "    Generate a Cloudflare Origin Certificate and place files at:"
    echo "      /etc/ssl/cloudflare/draw.biswas.me.pem"
    echo "      /etc/ssl/cloudflare/draw.biswas.me.key"
    echo "    Then re-run this script."
else
    echo "    SSL certificate found."
fi

echo "==> Validating and reloading nginx..."
sudo nginx -t && sudo systemctl reload nginx

echo "==> Building and starting container..."
cd /home/ubuntu/go-draw

docker compose -f source/docker-compose.yml -p godraw build
docker compose -f source/docker-compose.yml -p godraw up -d

echo "==> Waiting for health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8090/health > /dev/null 2>&1; then
    echo "==> Health check passed! draw.biswas.me is live."
    exit 0
  fi
  sleep 1
done

echo "==> Health check timed out. Check: docker compose -f source/docker-compose.yml -p godraw logs"
exit 1
