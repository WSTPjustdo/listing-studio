@echo off
setlocal
set "FAIR_PAGE=%~dp0reports\fair-rehearsal-2026-11-01\index.html"
if not exist "%FAIR_PAGE%" (
  echo Prepared fair page not found. See reports\fair-rehearsal-2026-11-01\README.md.
  pause
  exit /b 1
)
set "FAIR_EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "FAIR_EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined FAIR_EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "FAIR_EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined FAIR_EDGE if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "FAIR_EDGE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
if not defined FAIR_EDGE (
  echo Microsoft Edge was not found. Install Edge, then double-click start-fair.cmd again.
  pause
  exit /b 1
)
start "" "%FAIR_EDGE%" --new-window "%FAIR_PAGE%"
exit /b 0
