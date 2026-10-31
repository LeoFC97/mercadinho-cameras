@echo off
rem Procura as cameras de novo (ex.: mudaram de IP) e reinicia o sistema.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
set "FFMPEG=%~dp0bin\ffmpeg.exe"
set "FFPROBE=%~dp0bin\ffprobe.exe"
echo Procurando as cameras na rede (uns 30-60s)...
python\python.exe -X utf8 scan_cameras.py > logs\scan.log 2>&1
findstr /C:"Provaveis cameras" /C:"Prováveis câmeras" /C:"Sem porta 554" /C:"Traceback" logs\scan.log
if not exist scan\cameras.json echo AVISO: a varredura falhou (veja logs\scan.log); usando os IPs conhecidos.
echo Testando a senha e gerando a configuracao...
python\python.exe -X utf8 setup_cameras.py --senha-arquivo "%~dp0senha.txt"
echo Reiniciando o sistema...
schtasks /End /TN "Mercadinho Cameras" >nul 2>&1
timeout /t 4 >nul
schtasks /Run /TN "Mercadinho Cameras"
echo Pronto. Painel: http://localhost:8099
pause
