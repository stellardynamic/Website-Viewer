#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Website Viewer needs Node.js 18 or newer."
  echo "Opening the Node.js download page..."
  echo "Install the current LTS version, then run this launcher again."
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "https://nodejs.org/" >/dev/null 2>&1 || true
  fi
  exit 1
fi

node scripts/start-viewer.js
