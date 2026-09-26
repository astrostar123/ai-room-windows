#!/bin/bash
# ============================================================
#  AI Room - double-click to start (Mac).
#  Runs quietly in the background and opens the Room. If it's
#  already running, this just opens the Room window again.
#  To stop it: gear button in the Room > Quit AI Room.
# ============================================================
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org and try again."
  read -r -n 1 -p "Press any key to close..."
  exit 1
fi

node server.js --background --open
echo ""
echo "AI Room is running. You can close this window."
