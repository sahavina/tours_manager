@echo off
rem Bat Tour Hub tren may dev trong cac cua so rieng, khong phu thuoc vao cua so da mo no.
rem Bam dup file nay de chay. Khong xoa du lieu. Dong 3 cua so "Tour Hub" de tat.
cd /d "%~dp0.."

curl -s -o nul -m 2 http://127.0.0.1:55421/rest/v1/
if not errorlevel 1 goto worker
start "Tour Hub stack" /min cmd /k pnpm dev:stack

echo Dang cho database san sang...
:wait
timeout /t 2 /nobreak >nul
curl -s -o nul -m 2 http://127.0.0.1:55421/rest/v1/
if errorlevel 1 goto wait

:worker
curl -s -o nul -m 2 http://127.0.0.1:3102/health
if errorlevel 1 start "Tour Hub worker" /min cmd /k pnpm dev:worker

curl -s -o nul -m 2 http://localhost:3101/
if errorlevel 1 start "Tour Hub web" /min cmd /k pnpm dev:admin

if /i not "%~1"=="--no-browser" start "" http://localhost:3101
