@echo off
setlocal
title LT100 servo calibration
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\web-console.ps1" -Page servo.html -Bridge
if errorlevel 1 pause
