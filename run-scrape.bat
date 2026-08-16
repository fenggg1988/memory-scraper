@echo off
REM Daily memory price scraper — RamRadar source (USD/GB)
REM Runs scraper.mjs which downloads the public RamRadar CSV.
setlocal
set "PROJECT_DIR=C:\Users\fengz\memory-scraper"
set "NODE_EXE=C:\Users\fengz\AppData\Local\Programs\Node\node.exe"
set "LOG_FILE=%PROJECT_DIR%\scrape.log"

cd /d "%PROJECT_DIR%"
echo [%date% %time%] BAT start >> "%LOG_FILE%"
"%NODE_EXE%" "%PROJECT_DIR%\scraper.mjs" >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo [%date% %time%] BAT end exit=%EXIT_CODE% >> "%LOG_FILE%"
exit /b %EXIT_CODE%
