@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install Node, then try again.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24) process.exit(1)"
if errorlevel 1 (
  echo Node.js 24 or newer is required. Update Node, then try again.
  pause
  exit /b 1
)
node --env-file-if-exists=.env scripts\open-workbench.mjs
if errorlevel 1 (
  echo.
  echo The workbench did not open. See the message above or run start-local.cmd.
  pause
  exit /b 1
)
exit /b 0
