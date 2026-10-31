#!/bin/bash
# Duplo clique: testa as chaves (chaves.txt) em cada câmera e gera o go2rtc.yaml.
cd "$(dirname "$0")/../app"   # tudo roda a partir de app/
mkdir -p scan
/usr/bin/env python3 -u ../mac/configurar_cameras.py "$@" 2>&1 | tee scan/configuracao.txt
echo
read -p "Pressione Enter para fechar."
