#!/bin/sh
set -eu
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl xz-utils libatomic1
if ! id guessgame >/dev/null 2>&1; then
  sudo -n useradd --system --home-dir /var/lib/guessgame --shell /usr/sbin/nologin guessgame
fi
sudo -n install -d -m 755 /opt/guessgame/releases
sudo -n install -d -o guessgame -g guessgame -m 700 /var/lib/guessgame /var/backups/guessgame /etc/guessgame
temp=$(mktemp -d)
trap 'rm -f "$temp/SHASUMS256.txt" "$temp/node.tar.xz"; rmdir "$temp"' EXIT
curl -fsSL https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt -o "$temp/SHASUMS256.txt"
archive=$(awk '$2 ~ /^node-v26\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' "$temp/SHASUMS256.txt")
test -n "$archive"
expected=$(awk -v file="$archive" '$2==file {print $1}' "$temp/SHASUMS256.txt")
curl -fsSL "https://nodejs.org/dist/latest-v26.x/$archive" -o "$temp/node.tar.xz"
actual=$(sha256sum "$temp/node.tar.xz" | cut -d' ' -f1)
test "$actual" = "$expected"
sudo -n tar -xJf "$temp/node.tar.xz" -C /opt
sudo -n ln -sfn "/opt/${archive%.tar.xz}" /opt/guessgame/node
/opt/guessgame/node/bin/node --version
