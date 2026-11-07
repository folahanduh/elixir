@echo off
rem Elixir: double-click to start  ·  demo.bat for fake data
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS from https://nodejs.org, then run this again. & pause & exit /b 1)
set ELIXIR_SUPERVISED=1
:run
if "%1"=="demo" (call npm run demo --silent) else (call npm start --silent)
if %errorlevel%==75 (set NO_OPEN=1& goto run)
pause
