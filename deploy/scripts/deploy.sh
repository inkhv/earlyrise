#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[1/3] Installing deps..."
pnpm i --frozen-lockfile

echo "[2/3] Building workspaces..."
pnpm -C packages/shared build
pnpm -C packages/telegram build
pnpm -C packages/stt-nhn build
pnpm -C apps/api build
pnpm -C apps/bot build

echo "[3/3] Done."


