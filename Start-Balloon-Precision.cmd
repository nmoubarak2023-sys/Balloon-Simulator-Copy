@echo off
setlocal
cd /d "%~dp0"
set "BALLOON_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BALLOON_PY%" goto found
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined BALLOON_FOUND set "BALLOON_FOUND=%%P"
set "BALLOON_PY=%BALLOON_FOUND%"
if not defined BALLOON_PY goto missing
if not exist "%BALLOON_PY%" goto missing
:found
"%BALLOON_PY%" -c "import sys;from pathlib import Path;r=Path.cwd();sys.path[:0]=[str(r/'.precision-python'),str(r.parents[1]/'work'/'geometry-python')];import numpy,pymeshlab" >nul 2>nul
if not errorlevel 1 goto serve
echo Installing the pinned precision engine. This is only needed once.
if not exist ".precision-jobs" mkdir ".precision-jobs"
set "TMPDIR=%CD%\.precision-jobs"
"%BALLOON_PY%" -m pip install --no-cache-dir --target ".precision-python" -r "precision\requirements.txt"
if errorlevel 1 goto failed
:serve
"%BALLOON_PY%" "precision\server.py"
if errorlevel 1 goto failed
exit /b 0
:missing
echo Python 3.12 or newer was not found. Install Python from python.org, then try again.
pause
exit /b 1
:failed
echo Precision engine could not start. The error is shown above.
pause
exit /b 1
