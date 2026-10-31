@echo off
rem Reconfigura as cameras em segundo plano (sem janela); acompanhe em logs\reconfigurar.log
start "" "%~dp0python\pythonw.exe" -X utf8 "%~dp0reconfigurar.py"
