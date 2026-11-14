@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SuperAgent

if not exist node_modules (
  echo [首次运行] 安装依赖...
  call npm.cmd install --no-audit --no-fund
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b
)

echo 未找到 Electron，请先运行 npm install
pause
