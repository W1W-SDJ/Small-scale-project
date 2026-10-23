@echo off
rem Wrapper: this machine's execution policy blocks .ps1 files, so run the
rem script in a child PowerShell started with -ExecutionPolicy Bypass.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dragtest.ps1" %*
