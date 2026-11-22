@echo off
setlocal
cd /d "%~dp0"
set "COPY_NODE=%~dp0.local-runtime\node.exe"
if exist "%COPY_NODE%" goto found
set "COPY_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined COPY_NODE set "COPY_NODE=%%N"
if not defined COPY_NODE goto missing
:found
"%COPY_NODE%" scripts\start-local.mjs %*
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
