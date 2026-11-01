@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-amazon.ps1
if errorlevel 1 goto failed
echo Amazon scraper installed. Run start-local.cmd to open the workbench.
pause
exit /b 0
:failed
echo Setup failed. Install Python 3.14 and check network access to PyPI.
pause
exit /b 1
