@echo off
setlocal
title LT100 portal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\web-console.ps1" -Page index.html -Bridge
if errorlevel 1 pause
