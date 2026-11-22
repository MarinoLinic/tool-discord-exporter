@echo off
setlocal
cd /d "%~dp0"
node -e "if (+process.versions.node.split('.')[0] < 24) process.exit(1)" >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or later. 1>&2
  exit /b 2
)
call npm ci --no-audit --no-fund
if errorlevel 1 exit /b %ERRORLEVEL%
node -e "require('electron')"
exit /b %ERRORLEVEL%
