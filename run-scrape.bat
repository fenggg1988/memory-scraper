@echo off
cd /d C:\Users\fengz\memory-scraper
set PATH=C:\Program Files\nodejs;%PATH%
echo [%date% %time%] Starting scrape... >> scrape.log
node scraper.mjs >> scrape.log 2>&1
echo [%date% %time%] Done. >> scrape.log
