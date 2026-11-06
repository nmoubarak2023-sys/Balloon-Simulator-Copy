@echo off
setlocal
cd /d "%~dp0"
set "COPY_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%COPY_NODE%" goto found
set "COPY_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined COPY_NODE set "COPY_NODE=%%N"
if not defined COPY_NODE goto missing
:found
"%COPY_NODE%" scripts\prepare-vendor.js
if errorlevel 1 goto failed
echo Independent website copy: http://127.0.0.1:5180
"%COPY_NODE%" node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5180 --strictPort
if errorlevel 1 goto failed
exit /b 0
:missing
echo Node.js could not be found. Install Node.js 22 or newer.
pause
exit /b 1
:failed
echo The copy could not start. The error is shown above.
pause
exit /b 1
