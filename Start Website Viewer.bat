@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Website Viewer needs Node.js 18 or newer.
  echo Opening the Node.js download page...
  echo Install the current LTS version, then run this launcher again.
  start "" "https://nodejs.org/"
  echo.
  pause
  exit /b 1
)

node scripts\start-viewer.js
if errorlevel 1 (
  echo.
  pause
)
