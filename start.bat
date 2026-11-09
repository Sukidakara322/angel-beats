@echo off
REM Sound Pad launcher: starts the local server and opens the app.
cd /d "%~dp0"
start "" http://localhost:5188
node server.js
