#!/bin/sh
# Backup launcher for the Mac package (D-111). Double-click it in Finder.
# Runs the server with the Node built into CuavDemo.app and opens the system
# browser. Closing this Terminal window stops the server.
# ASCII only, LF line endings. Chinese messages are printed by launch.mjs.
#
# If port 8080 is taken by another program, change the number below.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8080}"
export PORT
ELECTRON_RUN_AS_NODE=1 exec "./CuavDemo.app/Contents/MacOS/Electron" ./launch.mjs
