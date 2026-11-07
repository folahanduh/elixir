#!/usr/bin/env bash
# Elixir: double-click (Mac: start.command) or run ./start.sh  ·  ./start.sh demo for fake data
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS from https://nodejs.org, then run this again."; read -r -p "Press Enter to close"; exit 1; }
if [ "$1" = "demo" ]; then npm run demo --silent; else npm start --silent; fi
