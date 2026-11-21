@echo off
setlocal
title LT100 serial console
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\web-console.ps1" -Page serial.html -Bridge
if errorlevel 1 pause
