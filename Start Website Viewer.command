#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Website Viewer needs Node.js 18 or newer."
  echo "Opening the Node.js download page..."
  echo "Install the current LTS version, then run this launcher again."
  if command -v open >/dev/null 2>&1; then
    open "https://nodejs.org/"
  fi
  echo
  read -r -p "Press Return to close this window..."
  exit 1
fi

node scripts/start-viewer.js
status=$?
if [ "$status" -ne 0 ]; then
  echo
  read -r -p "Press Return to close this window..."
fi
exit "$status"
