@echo off
REM Serve this folder for local use and for phones on the same network.
REM
REM Must be http:// and not https://: Web Serial needs a secure context, and
REM http://localhost counts as one, while the Wi-Fi transport needs the page NOT
REM to be HTTPS. Serving locally over http is the only way to get both at once.

setlocal
set PORT=8765
cd /d "%~dp0"

echo.
echo   PMC-Eight tools
echo   ---------------
echo   This machine : http://localhost:%PORT%/
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  for /f "tokens=*" %%b in ("%%a") do echo   On the network: http://%%b:%PORT%/
)
echo.
echo   Ctrl+C to stop.
echo.

python -m http.server %PORT% --bind 0.0.0.0
