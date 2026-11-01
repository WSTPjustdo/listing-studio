@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing
node -e "if(Number(process.versions.node.split('.')[0])<24) process.exit(1)"
if errorlevel 1 goto oldnode
if not exist node_modules (
  echo [1/3] Installing dependencies. Needs internet; about a minute the first time.
  echo       Nothing is frozen. The next line appears when this step finishes.
  call npm ci
  if errorlevel 1 goto failed
) else (
  echo [1/3] Dependencies already installed.
)
echo [2/3] Building.
call npm run build
if errorlevel 1 goto failed
echo [3/3] Starting the server. Keep this window open.
echo Open the URL printed by the server below. Default: http://127.0.0.1:8787/
echo Amazon search also requires setup-amazon.cmd once.
call npm start
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="3" goto alreadyrunning
if not "%CODE%"=="0" goto failed
exit /b 0

:missing
echo Node.js was not found on PATH.
echo Please install Node.js 24 or newer, then run this file again.
pause
exit /b 1

:oldnode
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEV=%%v"
echo This machine has Node %NODEV% on PATH, but this project needs Node.js 24 or newer.
echo Install Node.js 24+ and run this file again. If several Node versions are installed,
echo make sure the 24+ one comes first on PATH.
pause
exit /b 1

:alreadyrunning
echo.
echo Listing Studio is already running on this port (see the message above).
echo Just open http://127.0.0.1:8787/ in the browser. Nothing is broken.
pause
exit /b 0

:failed
echo.
echo Startup failed. The reason is in the lines above.
echo   - "port ... already in use" / "set PORT=": another program holds the port
echo   - "npm ci" errors: no network, or a corrupted cached package
echo   - build errors: run "npm run build" in this folder to see the full list
pause
exit /b 1
