@echo off
rem Elixir: double-click this file, or in PowerShell type:  .\start.bat     (demo.bat = fake data)
cd /d "%~dp0"
where node >nul 2>nul && goto ready
if exist "%~dp0bin\node\node.exe" goto portable
echo.
echo   Node.js isn't installed on this PC.
echo   Getting a portable copy just for Elixir (one time, about 30 MB, no admin rights needed)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1"
if errorlevel 1 goto nonode
:portable
set "PATH=%~dp0bin\node;%PATH%"
:ready
set ELIXIR_SUPERVISED=1
:run
if "%1"=="demo" (call npm run demo --silent) else (call npm start --silent)
if %errorlevel%==75 (set NO_OPEN=1& goto run)
pause
exit /b 0
:nonode
echo.
echo   Couldn't download Node.js automatically (no internet, or blocked on this network).
echo   Install the LTS version from https://nodejs.org (or ask IT to), then run this again.
echo.
pause
exit /b 1
