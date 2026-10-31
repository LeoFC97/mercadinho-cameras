#!/usr/bin/env python3
# testar_senha.py — testa UMA senha (admin:<senha>) em todas as câmeras da varredura
# e, se abrir, grava o go2rtc.yaml. A senha vem de senha_teste.txt (não fica no script).
import json, os, sys, subprocess, re
from urllib.parse import quote

HERE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))  # dados/config ficam em app/
SCAN = os.path.join(HERE, "scan", "cameras.json")
YAML = os.path.join(HERE, "go2rtc.yaml")
SENHA_FILE = os.path.join(HERE, "senha_teste.txt")
FFPROBE = "/opt/homebrew/bin/ffprobe" if os.path.exists("/opt/homebrew/bin/ffprobe") else "ffprobe"

def rtsp_url(user, pw, ip, subtype=0):
    return f"rtsp://{quote(user, safe='')}:{quote(pw, safe='')}@{ip}:554/cam/realmonitor?channel=1&subtype={subtype}"

def mask(s):
    return re.sub(r"://[^:/]+:[^@]+@", "://***:***@", s or "")

def testar(url):
    cmd = [FFPROBE, "-v", "error", "-rtsp_transport", "tcp", "-timeout", "8000000",
           "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,avg_frame_rate",
           "-of", "csv=p=0", url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return False, "tempo esgotado"
    if r.returncode == 0 and r.stdout.strip():
        return True, r.stdout.strip()
    err = mask(r.stderr or "").strip().splitlines()
    return False, (err[-1] if err else "falhou")

def main():
    if not os.path.exists(SCAN):
        print("Rode antes o 1-procurar-cameras.command."); sys.exit(1)
    if not os.path.exists(SENHA_FILE):
        print("Falta senha_teste.txt (uma senha por arquivo)."); sys.exit(1)
    ips = json.load(open(SCAN)).get("provaveis_cameras", [])
    user = "admin"
    pw = open(SENHA_FILE).read().strip()
    if not pw:
        print("senha_teste.txt está vazio."); sys.exit(1)
    print(f"Testando usuário '{user}' + senha (oculta) em {len(ips)} câmera(s)...\n")
    ok = {}
    for ip in ips:
        sucesso, info = testar(rtsp_url(user, pw, ip))
        print(f"  {ip}: {'OK  ' + info if sucesso else 'FALHOU (' + info + ')'}", flush=True)
        if sucesso:
            ok[ip] = (user, pw)
    print("\n" + "=" * 56)
    print(f"{len(ok)} de {len(ips)} câmeras abriram com essa senha.")
    if not ok:
        print("Essa senha não abriu nenhuma. Tente outra em senha_teste.txt."); return
    linhas = ["# go2rtc — câmeras do mercadinho (gerado por testar_senha.py)",
              "# stream principal: subtype=0 (1080p); secundário: subtype=1",
              "api:", '  listen: ":1984"', "rtsp:", '  listen: ":8554"', "webrtc:", '  listen: ":8555"', "streams:"]
    for ip in ips:
        if ip in ok:
            u, p = ok[ip]
            nome = "cam_" + ip.split(".")[-1]
            linhas.append(f"  {nome}:")
            linhas.append(f"    - {rtsp_url(u, p, ip)}")
            linhas.append(f"    - {rtsp_url(u, p, ip, 1)}")  # sub-stream como fonte alternativa
    open(YAML, "w").write("\n".join(linhas) + "\n")
    os.chmod(YAML, 0o600)
    print(f"go2rtc.yaml gravado com {len(ok)} câmera(s). Agora dê dois cliques em 3-iniciar-cameras.command.")

if __name__ == "__main__":
    main()
