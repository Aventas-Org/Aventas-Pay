@echo off
title Aventas Pay Unified Server
echo ============================================================
echo   Aventas Pay - Unified Server (Port 4000)
echo ============================================================
echo   Admin Dashboard:    http://localhost:4000/
echo   Products & Embeds:  http://localhost:4000/products
echo   Slice Email Check:  Every 5 seconds (pure TLS IMAP)
echo ============================================================
node --experimental-strip-types website/src/server.ts
pause
