#!/usr/bin/env python3
"""Monta o instalador de Windows (um unico .bat) a partir do codigo do repo.

  python3 windows/build.py  ->  dist/instalar-cameras-mercadinho.bat

O .bat e um poliglota batch/PowerShell: as primeiras linhas sao batch e chamam o
PowerShell com o proprio arquivo; o corpo e windows/instalador-corpo.ps1; no fim vai
a pasta app/ inteira compactada (zip em base64) na variavel $PAYLOAD.
"""
import base64, io, os, zipfile, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
OUT = os.path.join(ROOT, "dist", "instalar-cameras-mercadinho.bat")

# arquivos locais/segredos que nunca entram no pacote
SKIP_DIRS = {"rec", "scan", "logs", "__pycache__", "downloads"}
SKIP_FILES = {"config.js", "go2rtc.yaml", "gravador.env", "senha_teste.txt", "chaves.txt",
              "go2rtc", "go2rtc.exe", ".DS_Store"}

HEADER = """<# : Cameras do Mercadinho - instalador (parte batch; o resto e PowerShell)
@echo off
chcp 65001 >nul
title Cameras do Mercadinho - instalador
set "MC_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:MC_SELF))"
if errorlevel 99 exit /b
echo.
pause
exit /b
#>
"""

def payload():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for d, dirs, files in os.walk(APP):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for f in sorted(files):
                if f in SKIP_FILES or f.endswith(".pyc"):
                    continue
                p = os.path.join(d, f)
                z.write(p, os.path.relpath(p, APP).replace(os.sep, "/"))
    b = base64.b64encode(buf.getvalue()).decode()
    return "\n".join(b[i:i + 100] for i in range(0, len(b), 100))

def main():
    corpo = open(os.path.join(ROOT, "windows", "instalador-corpo.ps1"), encoding="ascii").read()
    corpo = corpo.replace("\r\n", "\n").rstrip("\n") + "\n"
    txt = HEADER + corpo + "\n$PAYLOAD = @'\n" + payload() + "\n'@\n\nMain\n"
    txt.encode("ascii")  # PowerShell 5 le o .bat como ANSI: so ASCII
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="\r\n", encoding="ascii") as fh:
        fh.write(txt)
    h = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    print(f"{OUT}\n{os.path.getsize(OUT)} bytes  sha256 {h}")

if __name__ == "__main__":
    main()
