@echo off
setlocal
title LT100 serial console
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\web-console.ps1"
if errorlevel 1 pause
