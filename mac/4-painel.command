#!/bin/bash
# Painel das câmeras — inicia o go2rtc + servidor local do painel React e abre no navegador.
cd "$(dirname "$0")/../app"   # tudo roda a partir de app/
PORT=8099
xattr -dr com.apple.quarantine go2rtc 2>/dev/null
chmod +x go2rtc
codesign --force --sign - go2rtc 2>/dev/null
mkdir -p scan

# Para instâncias anteriores iniciadas por este painel
pkill -f "go2rtc -config" 2>/dev/null
pkill -f "http.server ${PORT}" 2>/dev/null
sleep 1
# espera a porta 1984 liberar
for i in $(seq 1 20); do curl -s http://localhost:1984/api/streams >/dev/null 2>&1 || break; sleep 0.3; done

echo "Iniciando go2rtc..."
./go2rtc -config go2rtc.yaml > scan/go2rtc.log 2>&1 &
G2=$!
for i in $(seq 1 40); do curl -s "http://localhost:1984/api/streams" >/dev/null 2>&1 && break; sleep 0.25; done

echo "Gerando configuração do painel..."
python3 gen_config.py

echo "Iniciando servidor do painel..."
( cd ui && exec python3 -m http.server ${PORT} --bind 127.0.0.1 ) > scan/ui.log 2>&1 &
UI=$!
sleep 0.8

URL="http://localhost:${PORT}/"
echo "============================================================"
echo "  PAINEL DAS CÂMERAS:  $URL"
echo "  (go2rtc/diagnóstico:  http://localhost:1984 )"
echo "  Para PARAR tudo: feche esta janela (ou Ctrl+C)."
echo "============================================================"
( sleep 1; open "$URL" ) &

cleanup(){ echo; echo "Encerrando..."; kill $G2 $UI 2>/dev/null; pkill -f "http.server ${PORT}" 2>/dev/null; exit 0; }
trap cleanup EXIT INT TERM
wait $G2
