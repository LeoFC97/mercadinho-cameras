#!/bin/bash
# Duplo clique: testa a senha de senha_teste.txt em todas as câmeras e, se abrir, gera o go2rtc.yaml.
cd "$(dirname "$0")/../app"   # tudo roda a partir de app/
mkdir -p scan
/usr/bin/env python3 -u ../mac/testar_senha.py 2>&1 | tee scan/teste_senha.txt
echo
read -p "Pressione Enter para fechar."
