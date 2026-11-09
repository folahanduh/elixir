#!/usr/bin/env bash
# Elixir: run ./start.sh (Mac: double-click start.command)  ·  ./start.sh demo for fake data
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS from https://nodejs.org, then run this again."; read -r -p "Press Enter to close"; exit 1; }
export ELIXIR_SUPERVISED=1
for a in "$@"; do [ "$a" = "--no-open" ] && export NO_OPEN=1; done   # ./start.sh --no-open: don't open a browser
while true; do
  if [ "$1" = "demo" ] || [ "$2" = "demo" ]; then npm run demo --silent; else npm start --silent; fi
  code=$?
  [ "$code" -eq 75 ] || exit "$code"   # 75 = updated itself: start the new version
  export NO_OPEN=1
done
