@echo off
rem Elixir: double-click this file, or in PowerShell type:  .\start.bat     (demo.bat = fake data)
cd /d "%~dp0"
where node >nul 2>nul && goto ready
rem Node.js installed by fnm / nvm-windows / the installer, just not on PATH in this window: use it.
set "NODEDIR="
for /d %%D in ("%APPDATA%\fnm\node-versions\v*") do if exist "%%D\installation\node.exe" set "NODEDIR=%%D\installation"
if not defined NODEDIR for /d %%D in ("%LOCALAPPDATA%\fnm\node-versions\v*") do if exist "%%D\installation\node.exe" set "NODEDIR=%%D\installation"
if not defined NODEDIR if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODEDIR=%NVM_SYMLINK%"
if not defined NODEDIR for /d %%D in ("%APPDATA%\nvm\v*") do if exist "%%D\node.exe" set "NODEDIR=%%D"
if not defined NODEDIR if exist "%ProgramFiles%\nodejs\node.exe" set "NODEDIR=%ProgramFiles%\nodejs"
if not defined NODEDIR goto nofound
set "PATH=%NODEDIR%;%PATH%"
goto ready
:nofound
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
