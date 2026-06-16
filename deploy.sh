#!/bin/bash
set -e

APP_NAME="clickup-plextrac"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Pulling latest code..."
git -C "$APP_DIR" pull

echo "==> Installing dependencies..."
npm --prefix "$APP_DIR" install --omit=dev

echo "==> Restarting application..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$APP_NAME"
else
    pm2 start "$APP_DIR/index.js" --name "$APP_NAME"
    pm2 save
fi

echo "==> Done. App is running on port 4000."
