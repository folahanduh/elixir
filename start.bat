@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org ^(LTS^) & pause & exit /b 1)
if not exist node_modules\@anthropic-ai\sdk call npm install --no-audit --no-fund
if "%1"=="demo" (node server.js --demo) else (node server.js)
pause
