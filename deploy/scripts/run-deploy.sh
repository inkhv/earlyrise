#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo ">>> pulling latest main"
git pull --ff-only

echo ">>> running deploy build"
bash deploy/scripts/deploy.sh

echo ">>> restarting services"
systemctl restart earlyrise-api earlyrise-bot

echo ">>> services status"
systemctl status earlyrise-api --no-pager
systemctl status earlyrise-bot --no-pager

