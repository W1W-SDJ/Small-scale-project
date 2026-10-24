@echo off
rem Create a desktop shortcut for this copy of the pet.
rem
rem Deliberately not an installer: the app is a folder you can move anywhere, and
rem an unsigned installer .exe is exactly what Smart App Control blocks. A .cmd
rem that writes one shortcut works on every machine and installs nothing.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1"
echo.
pause
