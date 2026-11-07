#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get it from https://nodejs.org (LTS)"; exit 1; }
[ -d node_modules/@anthropic-ai/sdk ] || npm install --no-audit --no-fund || echo "(npm install failed: the Claude judge stays off, everything else works)"
if [ "$1" = "demo" ]; then node server.js --demo; else node server.js; fi
