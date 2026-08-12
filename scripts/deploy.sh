#!/bin/bash
# Auto-deploy script — runs on every GitHub push to main/master
set -e
cd /opt/whatsapp-bot

LOG="/var/log/whatsapp-deploy.log"
exec >> "$LOG" 2>&1

echo "==============================="
echo "[$(date)] Deploy started"
echo "==============================="

# Increase file descriptor limit
ulimit -n 65536

# Pull latest code from GitHub
echo "[$(date)] git pull..."
GIT_SSH_COMMAND="ssh -i /root/.ssh/github_deploy -o StrictHostKeyChecking=no" git pull origin main 2>&1 || \
GIT_SSH_COMMAND="ssh -i /root/.ssh/github_deploy -o StrictHostKeyChecking=no" git pull origin master 2>&1 || true

# Install dependencies (frozen lockfile — no lockfile changes)
echo "[$(date)] pnpm install..."
pnpm install --frozen-lockfile 2>&1

# Build API server
echo "[$(date)] Build API..."
pnpm --filter @workspace/api-server run build 2>&1

# Build Frontend
echo "[$(date)] Build Frontend..."
pnpm --filter @workspace/support-connect run build 2>&1

# Restart PM2 processes (preserve WhatsApp session — only restart API + frontend)
echo "[$(date)] Restart PM2..."
pm2 restart whatsapp-api whatsapp-frontend 2>&1
pm2 save 2>&1

echo "[$(date)] Deploy complete!"
echo "==============================="
