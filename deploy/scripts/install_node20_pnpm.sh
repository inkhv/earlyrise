#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates
fi

echo "[1/3] Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "[2/3] Enabling corepack + pnpm..."
corepack enable || true
corepack prepare pnpm@9.15.3 --activate

echo "[3/3] Versions:"
node -v
npm -v
pnpm -v


