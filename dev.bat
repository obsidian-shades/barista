@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Everyday start: the release exe plus Vite. Skips Cargo, so :3000 is up immediately.
rem After you change Rust, run:  dev.bat rebuild

echo Stopping anything still bound to 3000 or 5173...
call :killport 3000
call :killport 5173
taskkill /F /IM barista-server.exe >nul 2>&1

if /I "%~1"=="rebuild" goto build
if not exist "engine\target\release\barista-server.exe" goto build
goto launch

:build
echo Building the release engine. This is the slow step, and it is only needed after Rust changes.
cargo build --release --manifest-path engine\Cargo.toml
if errorlevel 1 (
  echo Build failed. Engine was not started.
  exit /b 1
)

:launch
if not exist "engine\target\release\barista-server.exe" (
  echo Release binary is missing: engine\target\release\barista-server.exe
  exit /b 1
)

rem Run a copy outside target\release so the live process does not lock the next cargo build.
if not exist "engine\target\run" mkdir "engine\target\run"
copy /Y "engine\target\release\barista-server.exe" "engine\target\run\barista-server.exe" >nul
if errorlevel 1 (
  echo Could not copy the server exe. A copy may still be running.
  exit /b 1
)

start "barista engine" /D "%~dp0" cmd /k engine\target\run\barista-server.exe
start "barista editor" /D "%~dp0" cmd /k pnpm dev

echo Waiting for the engine on :3000 and the editor on :5173...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ $n = netstat -ano | Select-String 'LISTENING'; if(($n -match ':3000\s') -and ($n -match ':5173\s')){ $ok=$true; break }; Start-Sleep -Milliseconds 250 }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo Timed out. Check the "barista engine" and "barista editor" windows.
  exit /b 1
)

echo Engine  http://127.0.0.1:3000/api
echo Editor  http://localhost:5173
start "" "http://localhost:5173"
exit /b 0

:killport
for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%~1 " ^| findstr "LISTENING"') do (
  echo   stopping pid %%I on port %~1
  taskkill /F /PID %%I >nul 2>&1
)
exit /b 0
