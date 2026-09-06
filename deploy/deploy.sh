#!/usr/bin/env bash
#
# Deploy blog tinh len VPS qua rsync.
#
# Cach dung:
#   ./deploy/deploy.sh
#
# Hoac ghi de cau hinh bang bien moi truong:
#   REMOTE_HOST=user@1.2.3.4 REMOTE_PATH=/var/www/blog ./deploy/deploy.sh
#
set -euo pipefail

# ---------- Cau hinh (sua o day hoac dat bien moi truong) ----------
REMOTE_HOST="${REMOTE_HOST:-user@example.com}"
REMOTE_PATH="${REMOTE_PATH:-/var/www/blog}"
SSH_PORT="${SSH_PORT:-22}"

# ---------- Kiem tra ----------
cd "$(dirname "$0")/.."

if [[ "$REMOTE_HOST" == "user@example.com" ]]; then
  echo "LOI: chua cau hinh REMOTE_HOST."
  echo "     Sua truc tiep trong deploy/deploy.sh hoac chay:"
  echo "     REMOTE_HOST=user@ip-cua-ban ./deploy/deploy.sh"
  exit 1
fi

# ---------- Build ----------
echo "==> Build site..."
pnpm build

if [[ ! -d dist ]]; then
  echo "LOI: khong tim thay thu muc dist/ sau khi build."
  exit 1
fi

if [[ ! -f dist/index.html ]]; then
  echo "LOI: dist/index.html khong ton tai — build co ve that bai."
  exit 1
fi

# ---------- Xem truoc thay doi ----------
echo
echo "==> Cac thay doi se duoc day len $REMOTE_HOST:$REMOTE_PATH"
rsync -azn --delete --itemize-changes \
  -e "ssh -p $SSH_PORT" \
  dist/ "$REMOTE_HOST:$REMOTE_PATH/" | head -50

echo
read -r -p "Tiep tuc deploy? [y/N] " answer
if [[ ! "$answer" =~ ^[Yy]$ ]]; then
  echo "Da huy."
  exit 0
fi

# ---------- Day len ----------
echo "==> Dang dong bo..."
rsync -az --delete \
  --human-readable \
  --stats \
  -e "ssh -p $SSH_PORT" \
  dist/ "$REMOTE_HOST:$REMOTE_PATH/"

echo
echo "==> Xong. Kiem tra lai site cua ban."
