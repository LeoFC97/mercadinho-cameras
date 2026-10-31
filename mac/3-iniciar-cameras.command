#!/bin/bash
# Duplo clique: inicia o go2rtc e abre o mosaico das câmeras no navegador.
cd "$(dirname "$0")/../app"   # tudo roda a partir de app/
xattr -dr com.apple.quarantine go2rtc 2>/dev/null
chmod +x go2rtc
# Assina ad-hoc (necessário para binário não-assinado rodar no Apple Silicon)
codesign --force --sign - go2rtc 2>/dev/null
CAMS=$(/usr/bin/env python3 - <<'PY'
import re
nomes, dentro = [], False
for linha in open('go2rtc.yaml'):
    if linha.startswith('streams:'):
        dentro = True; continue
    if dentro and re.match(r'^\S', linha):
        dentro = False
    m = re.match(r'^  ([\w-]+):', linha)
    if dentro and m:
        nomes.append(m.group(1))
print('&'.join('src=' + n for n in nomes))
PY
)
if [ -z "$CAMS" ]; then
  echo "Nenhuma câmera configurada em go2rtc.yaml."; echo; read -p "Enter para sair"; exit 1
fi
URL="http://localhost:1984/stream.html?${CAMS}&mode=mse"
echo "============================================================"
echo " Mosaico das câmeras:  $URL"
echo " Painel do go2rtc:      http://localhost:1984"
echo " Para PARAR: feche esta janela (ou Ctrl+C)."
echo "============================================================"
( sleep 2; open "$URL" ) &
exec ./go2rtc -config go2rtc.yaml
