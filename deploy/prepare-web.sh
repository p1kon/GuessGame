#!/bin/sh
set -eu
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx python3-venv
sudo -n install -d -m 755 /var/www/guessgame-acme/.well-known/acme-challenge
sudo -n python3 -m venv /opt/guessgame-certbot
sudo -n /opt/guessgame-certbot/bin/pip install --quiet 'certbot>=5.4,<6'
# Bootstrap HTTP serves only ACME challenges until the application is ready.
printf '%s\n' 'server { listen 80 default_server; server_name 67.21.76.143; location /.well-known/acme-challenge/ { root /var/www/guessgame-acme; } location / { return 503; } }' | sudo -n tee /etc/nginx/sites-available/guessgame >/dev/null
sudo -n ln -sfn /etc/nginx/sites-available/guessgame /etc/nginx/sites-enabled/guessgame
sudo -n rm -f /etc/nginx/sites-enabled/default
sudo -n nginx -t
sudo -n systemctl enable --now nginx
sudo -n systemctl reload nginx
sudo -n ufw allow 80/tcp
sudo -n ufw allow 443/tcp
sudo -n /opt/guessgame-certbot/bin/certbot certonly --webroot -w /var/www/guessgame-acme \
  --preferred-profile shortlived --ip-address 67.21.76.143 --cert-name guessgame-ip \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --deploy-hook 'systemctl reload nginx'
