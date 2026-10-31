#!/usr/bin/env python3
# configurar_cameras.py — pede usuário/senha RTSP, testa cada câmera encontrada na varredura e gera o go2rtc.yaml.
import json, os, sys, subprocess, getpass
from urllib.parse import quote

HERE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))  # dados/config ficam em app/
SCAN = os.path.join(HERE, "scan", "cameras.json")
YAML = os.path.join(HERE, "go2rtc.yaml")
FFPROBE = "/opt/homebrew/bin/ffprobe" if os.path.exists("/opt/homebrew/bin/ffprobe") else "ffprobe"

def rtsp_url(user, pw, ip, subtype=0):
    return f"rtsp://{quote(user, safe='')}:{quote(pw, safe='')}@{ip}:554/cam/realmonitor?channel=1&subtype={subtype}"

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
    import re
    err = re.sub(r"://[^:/]+:[^@]+@", "://***:***@", (r.stderr or "")).strip().splitlines()
    return False, (err[-1] if err else "falhou")

def main():
    if not os.path.exists(SCAN):
        print("Rode antes o 1-procurar-cameras.command."); sys.exit(1)
    data = json.load(open(SCAN))
    ips = data.get("provaveis_cameras", [])
    extras = [a for a in sys.argv[1:] if a.count(".") == 3]
    for ip in extras:
        if ip not in ips: ips.append(ip)
    if not ips:
        print("Nenhuma câmera na varredura."); sys.exit(1)
    print("Câmeras encontradas:", ", ".join(ips))
    KEYS = os.path.join(HERE, "chaves.txt")
    if os.path.exists(KEYS):
        chaves = []
        for l in open(KEYS):
            l = l.strip()
            if l and not l.startswith("#"):
                partes = l.split()
                chaves.append((partes[0], partes[1] if len(partes) > 1 else ""))
        print(f"Modo automático: {len(chaves)} chave(s) de chaves.txt, usuário admin.")
        ok, usadas = {}, set()
        for ip in ips:
            print(f"\nTestando {ip} ...", flush=True)
            for i, (chave, ns) in enumerate(chaves, 1):
                if chave in usadas:
                    continue
                sucesso, info = testar(rtsp_url("admin", chave, ip))
                print(f"  chave #{i} ({ns or '?'}): {'OK ' + info if sucesso else 'não (' + info + ')'}", flush=True)
                if sucesso:
                    ok[ip] = ("admin", chave, ns); usadas.add(chave)
                    break
        gravar(ips, ok)
        return
    print("\nCredenciais RTSP (no app Mibo Smart: usuário 'admin' e a chave de acesso da câmera).")
    user = input("Usuário RTSP [admin]: ").strip() or "admin"
    pw = getpass.getpass("Senha / chave de acesso (não aparece ao digitar): ")
    ok = {}
    for ip in ips:
        print(f"\nTestando {ip} ... ", end="", flush=True)
        sucesso, info = testar(rtsp_url(user, pw, ip))
        if not sucesso:
            print(f"FALHOU ({info})")
            if "401" in info or "Unauthorized" in info:
                pw2 = getpass.getpass(f"  Senha diferente para {ip}? (Enter para pular): ")
                if pw2:
                    sucesso, info = testar(rtsp_url(user, pw2, ip))
                    if sucesso:
                        ok[ip] = (user, pw2); print(f"  OK: {info}")
                        continue
                    print(f"  FALHOU de novo ({info})")
            continue
        ok[ip] = (user, pw); print(f"OK: {info}")

    gravar(ips, ok)

def gravar(ips, ok):
    print("\n" + "=" * 60)
    print(f"{len(ok)} de {len(ips)} câmeras OK: {', '.join(ok) or '-'}")
    if not ok:
        print("Nenhuma câmera abriu. Confira usuário/senha no app Mibo Smart e rode de novo."); sys.exit(1)
    linhas = ["# go2rtc — câmeras do mercadinho (gerado por 2-configurar-cameras.command)",
              "# stream principal: subtype=0 (1080p); secundário: subtype=1",
              "api:", '  listen: ":1984"', "rtsp:", '  listen: ":8554"', "webrtc:", '  listen: ":8555"', "streams:"]
    for ip in ips:
        if ip in ok:
            u, p = ok[ip][0], ok[ip][1]
            ns = ok[ip][2] if len(ok[ip]) > 2 else ""
            nome = "cam_" + ip.split(".")[-1]
            linhas.append(f"  {nome}:" + (f"   # NS {ns}" if ns else ""))
            linhas.append(f"    - {rtsp_url(u, p, ip)}")
    with open(YAML, "w") as f:
        f.write("\n".join(linhas) + "\n")
    os.chmod(YAML, 0o600)
    print(f"go2rtc.yaml gravado com {len(ok)} câmera(s). Agora dê dois cliques em 3-iniciar-cameras.command.")

if __name__ == "__main__":
    main()
