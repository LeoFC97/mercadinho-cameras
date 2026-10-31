@echo off
rem Pede ao supervisor (que ja roda como SYSTEM) para procurar as cameras de novo e reiniciar. Nao precisa de administrador.
rem Acompanhe em logs\reconfigurar.log ou na tela Disco do painel.
if not exist "%~dp0pedidos" mkdir "%~dp0pedidos"
echo %date% %time%> "%~dp0pedidos\reconfigurar"
echo Pedido enviado. O sistema reinicia em alguns segundos; acompanhe em logs\reconfigurar.log
timeout /t 4 >nul
