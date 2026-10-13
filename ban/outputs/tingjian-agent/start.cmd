@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更高版本，然后重新运行。
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo 已创建 .env，请填写 COZE_API_TOKEN 和 COZE_BOT_ID，保存后重新运行。
  notepad .env
  exit /b 0
)
node --env-file-if-exists=.env server.mjs
pause
