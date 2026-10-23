@echo off
rem Launch the desktop pet, detached, without going through npm.
rem
rem Two reasons this exists instead of "npm start":
rem  * PowerShell resolves `npm` to npm.ps1, which this machine's execution
rem    policy refuses to run.
rem  * leaving the launcher out of the loop means no console window is kept open.
rem
rem "." (not an absolute path) is passed as the app path so Electron resolves it
rem against the working directory we just set — the same form as `electron .`.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
