@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "NF_EXIT=%ERRORLEVEL%"
echo.
if not "%NF_EXIT%"=="0" echo NovelForge Connector installation failed with exit code %NF_EXIT%.
pause
exit /b %NF_EXIT%
