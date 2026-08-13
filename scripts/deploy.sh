#!/bin/bash
# Auto-deploy — runs on every GitHub push to main/master
# Uses git reset --hard to handle any local modifications cleanly
cd /opt/whatsapp-bot

LOG="/var/log/whatsapp-deploy.log"
exec >> "$LOG" 2>&1

echo "==============================="
echo "[$(date)] Deploy started"
echo "==============================="

ulimit -n 65536

echo "[$(date)] git fetch + reset to origin/main..."
GIT_SSH_COMMAND="ssh -i /root/.ssh/github_deploy -o StrictHostKeyChecking=no" \
  git fetch origin 2>&1

# Force-sync with GitHub main — discards local modifications
GIT_SSH_COMMAND="ssh -i /root/.ssh/github_deploy -o StrictHostKeyChecking=no" \
  git reset --hard origin/main 2>&1 \
  || { echo "WARN: reset to main failed, trying master..."; \
       GIT_SSH_COMMAND="ssh -i /root/.ssh/github_deploy -o StrictHostKeyChecking=no" \
       git reset --hard origin/master 2>&1; }

echo "[$(date)] pnpm install..."
pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1 || true

echo "[$(date)] Build API..."
pnpm --filter @workspace/api-server run build 2>&1
API_EXIT=$?
echo "[$(date)] API build exit: $API_EXIT"

echo "[$(date)] Build Frontend..."
pnpm --filter @workspace/support-connect run build 2>&1
FE_EXIT=$?
echo "[$(date)] Frontend build exit: $FE_EXIT"

if [ $API_EXIT -eq 0 ] && [ $FE_EXIT -eq 0 ]; then
  echo "[$(date)] Both builds OK — restarting PM2..."
  pm2 restart whatsapp-api whatsapp-frontend 2>&1
  pm2 save 2>&1
  echo "[$(date)] ✅ Deploy complete!"
else
  echo "[$(date)] ⚠️ Build failed (api=$API_EXIT fe=$FE_EXIT) — NOT restarting to keep old version running"
fi
echo "==============================="
