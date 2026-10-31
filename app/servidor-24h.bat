@echo off
rem Configura o notebook para ficar ligado 24h (sem dormir, Wi-Fi sem economia, sem reinicio automatico). Log em logs\servidor_24h.log
start "" "%~dp0python\pythonw.exe" -X utf8 "%~dp0servidor_24h.py"
