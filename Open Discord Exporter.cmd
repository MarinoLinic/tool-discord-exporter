@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" (
  echo Run Setup.cmd first. 1>&2
  pause
  exit /b 2
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
