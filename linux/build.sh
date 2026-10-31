#!/bin/bash
# Monta dist/instalar-mercadinho.sh = linux/instalador-cabecalho.sh + pacote embutido
# (app/ + scripts de servidor Linux, tar.gz em base64 num heredoc).
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp -r app/. "$TMP/"
rm -rf "$TMP"/ui/rec "$TMP"/scan "$TMP"/logs "$TMP"/ui/config.js "$TMP"/go2rtc.yaml "$TMP"/gravador.env "$TMP"/reconfigurar.bat
find "$TMP" -name __pycache__ -prune -exec rm -rf {} +
cp linux/gravador-run.sh linux/mercadinho "$TMP/"
chmod 755 "$TMP"/*.py "$TMP"/*.sh "$TMP"/mercadinho
B64=$(tar -C "$TMP" -czf - . | base64 -w 76)
mkdir -p dist
python3 - "$B64" <<'PY'
import sys
b64 = sys.argv[1]
s = open("linux/instalador-cabecalho.sh").read()
fn = "payload(){ cat <<'__PACOTE_MERCADINHO__'\n" + b64 + "\n__PACOTE_MERCADINHO__\n}"
assert "#__PAYLOAD__" in s
open("dist/instalar-mercadinho.sh", "w").write(s.replace("#__PAYLOAD__", fn, 1))
PY
chmod 755 dist/instalar-mercadinho.sh
bash -n dist/instalar-mercadinho.sh && echo "sintaxe ok"
ls -la dist/instalar-mercadinho.sh; sha256sum dist/instalar-mercadinho.sh
