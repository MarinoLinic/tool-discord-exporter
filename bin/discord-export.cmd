@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or later. 1>&2
  exit /b 2
)
node "%~dp0..\cli.mjs" %*
exit /b %ERRORLEVEL%
