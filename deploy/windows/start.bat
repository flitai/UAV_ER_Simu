@echo off
rem Single-machine launcher for the C-UAV simulation system (W-2, D-099).
rem This file must stay ASCII only with CRLF line endings: cmd.exe reads it in
rem the system code page. Chinese messages are printed by launch.mjs instead.
rem
rem If port 8080 is taken by another program, change the number below.
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=8080
title C-UAV simulation server
"%~dp0node\node.exe" "%~dp0launch.mjs"
if errorlevel 1 pause
endlocal
