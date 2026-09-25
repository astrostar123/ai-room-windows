@echo off
rem ============================================================
rem  AI Room - double-click to start.
rem  Runs quietly in the background (no window to keep open)
rem  and opens the Room. If it's already running, this just
rem  opens the Room window again.
rem  To stop it: gear button in the Room > Quit AI Room.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)

node server.js --background --open
