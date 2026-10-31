#!/usr/bin/env python3
# reconfigurar.py — Windows: procura as câmeras de novo, testa a senha, gera a configuração
# e reinicia a tarefa "Mercadinho Cameras". Roda sem janela (pythonw) e escreve tudo em
# logs\reconfigurar.log. Precisa de administrador (senha.txt e go2rtc.yaml são restritos).
import os, sys, subprocess, ctypes, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, "python", "python.exe")
LOG = os.path.join(HERE, "logs", "reconfigurar.log")
TN = "Mercadinho Cameras"
NOWIN = 0x08000000

def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")

def run(args, timeout=600):
    env = dict(os.environ, FFMPEG=os.path.join(HERE, "bin", "ffmpeg.exe"),
               FFPROBE=os.path.join(HERE, "bin", "ffprobe.exe"), PYTHONIOENCODING="utf-8")
    r = subprocess.run(args, cwd=HERE, capture_output=True, timeout=timeout, env=env, creationflags=NOWIN)
    out = (r.stdout or b"").decode("utf-8", "replace") + (r.stderr or b"").decode("utf-8", "replace")
    for line in out.splitlines():
        log("  " + line.rstrip())
    return r.returncode

def main():
    os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
    try:
        admin = ctypes.windll.shell32.IsUserAnAdmin()
    except Exception:
        admin = False
    if not admin:
        # relança a si mesmo elevado (pede o "Sim" do Windows) e sai
        exe = PY.replace("python.exe", "pythonw.exe")
        ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, f'-X utf8 "{os.path.abspath(__file__)}"', HERE, 0)
        return
    log("===== reconfigurar: início =====")
    log("[1/3] procurando câmeras na rede...")
    run([PY, "-X", "utf8", os.path.join(HERE, "scan_cameras.py")])
    if not os.path.exists(os.path.join(HERE, "scan", "cameras.json")):
        log("  AVISO: a varredura falhou; usando os IPs conhecidos")
    log("[2/3] testando a senha e gerando a configuração...")
    run([PY, "-X", "utf8", os.path.join(HERE, "setup_cameras.py"), "--senha-arquivo", os.path.join(HERE, "senha.txt")])
    log("[3/3] reiniciando o sistema...")
    run(["schtasks", "/End", "/TN", TN], timeout=60)
    import time; time.sleep(4)
    run(["schtasks", "/Run", "/TN", TN], timeout=60)
    log("===== reconfigurar: fim (painel em http://localhost:8099) =====")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERRO: {type(e).__name__}: {e}")
