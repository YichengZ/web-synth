@echo off
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m http.server 8080
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8080
  goto :eof
)

echo Python 3 is required to start the offline site.
pause
