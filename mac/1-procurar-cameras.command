#!/bin/bash
# Duplo clique para procurar as câmeras na rede da loja.
cd "$(dirname "$0")/../app"   # tudo roda a partir de app/
mkdir -p scan
/usr/bin/env python3 -u scan_cameras.py 2>&1 | tee scan/ultimo-scan.txt
echo
echo "Pronto. Pode fechar esta janela."
