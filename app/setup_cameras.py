#!/usr/bin/env python3
# setup_cameras.py — testa a senha RTSP nas câmeras e gera go2rtc.yaml + ui/config.js.
# Uso: setup_cameras.py --senha-arquivo /caminho [--sem-teste]
import json, os, sys, subprocess, re, argparse
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
YAML = os.path.join(HERE, "go2rtc.yaml")

def rtsp(pw, ip, sub=0):
    return f"rtsp://admin:{quote(pw, safe='')}@{ip}:554/cam/realmonitor?channel=1&subtype={sub}"

def testar(url):
    try:
        r = subprocess.run([os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-rtsp_transport", "tcp", "-timeout", "6000000",
                            "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
                            "-of", "csv=p=0", url], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=15)
        if r.returncode == 0 and r.stdout.strip(): return True, r.stdout.strip()
        err = re.sub(r"://[^:/]+:[^@]+@", "://***:***@", r.stderr or "").strip().splitlines()
        return False, (err[-1] if err else "falhou")
    except subprocess.TimeoutExpired:
        return False, "sem resposta"

def candidatos():
    ips = []
    for fn in ("scan/cameras.json", "cameras_conhecidas.json"):
        try:
            for ip in json.load(open(os.path.join(HERE, fn))).get("provaveis_cameras", []):
                if ip not in ips: ips.append(ip)
        except Exception:
            pass
    return ips

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--senha-arquivo", required=True)
    ap.add_argument("--sem-teste", action="store_true")
    a = ap.parse_args()
    pw = open(a.senha_arquivo).read().strip()
    ips = candidatos()
    if not ips:
        print("Nenhuma câmera conhecida/encontrada."); sys.exit(1)
    ok, falhas = [], []
    if a.sem_teste:
        ok = ips
    else:
        for ip in ips:
            s, info = testar(rtsp(pw, ip))
            print(f"  {ip}: {'OK ' + info if s else 'falhou (' + info + ')'}", flush=True)
            (ok if s else falhas).append(ip)
        if not ok:
            print("\nNenhuma câmera respondeu (fora da rede da loja ou senha errada).")
            print("Vou configurar mesmo assim com os IPs conhecidos — quando estiver na loja rode: sudo mercadinho reconfigurar")
            ok = ips
    L = ["# go2rtc — câmeras do mercadinho (gerado por setup_cameras.py)",
         "# <id> = principal 1080p (subtype=0); <id>_sub = leve (subtype=1)",
         "api:", '  listen: ":1984"', '  origin: "*"',
         "rtsp:", '  listen: "127.0.0.1:8554"',
         "webrtc:", '  listen: ":8555"',
         "log:", "  level: info", "streams:"]
    for ip in ok:
        n = ip.split(".")[-1]
        L += [f"  cam_{n}:", f"    - {rtsp(pw, ip, 0)}", f"  cam_{n}_sub:", f"    - {rtsp(pw, ip, 1)}"]
    open(YAML, "w").write("\n".join(L) + "\n")
    os.chmod(YAML, 0o600)
    subprocess.run([sys.executable, os.path.join(HERE, "gen_config.py")], check=False)
    print(f"Configuradas {len(ok)} câmera(s): {', '.join(ok)}")

if __name__ == "__main__":
    main()
