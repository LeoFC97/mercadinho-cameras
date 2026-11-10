#!/usr/bin/env python3
# setup_cameras.py — testa a senha RTSP nas câmeras e gera go2rtc.yaml + ui/config.js.
# Uso: setup_cameras.py --senha-arquivo /caminho [--sem-teste]
import json, os, sys, subprocess, re, argparse, time
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
YAML = os.path.join(HERE, "go2rtc.yaml")
# Nome fixo por câmera (pelo endereço MAC): se o roteador der outro IP para a câmera, ela continua com o
# mesmo nome (cam_133 etc.) e as gravações seguem na mesma pasta. Fica em dados/ (nunca é sobrescrito/apagado).
MAPA = os.path.join(HERE, "dados", "cameras_mac.json")
REC = os.path.join(HERE, "ui", "rec")


def ler_mapa():
    try:
        return json.load(open(MAPA, encoding="utf-8"))
    except Exception:
        return {}


def salvar_mapa(m):
    os.makedirs(os.path.dirname(MAPA), exist_ok=True)
    tmp = MAPA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
    os.replace(tmp, MAPA)


def macs_da_varredura():
    try:
        return {h["ip"]: (h.get("mac") or "").upper() for h in json.load(open(os.path.join(HERE, "scan", "cameras.json"))).get("hosts", [])}
    except Exception:
        return {}


def config_atual():
    """{id: ip} do go2rtc.yaml de agora."""
    out, atual = {}, ""
    try:
        for line in open(YAML, encoding="utf-8"):
            m = re.match(r"^  ([\w-]+):\s*$", line)
            if m:
                atual = m.group(1)
            m2 = re.search(r"@([\d.]+):554", line)
            if m2 and not atual.endswith("_sub"):
                out[atual] = m2.group(1)
    except Exception:
        pass
    return out


def nomear(oks, macs):
    """Dá um nome estável para cada IP que respondeu: pelo MAC já conhecido, senão pelo nome que o IP já
    tinha na configuração (migração), senão cam_<final do IP> (sem reaproveitar pasta de outra câmera)."""
    mapa = ler_mapa()
    por_mac = {mac: v for mac, v in mapa.items() if not v.get("falhou")}
    atual = config_atual()
    usados, nomes = set(), {}
    for ip in oks:
        mac = macs.get(ip, "")
        cid = None
        if mac and mac in por_mac:
            cid = por_mac[mac]["id"]
        if not cid:
            cid = next((i for i, x in atual.items() if x == ip and not any(v.get("id") == i and m != mac for m, v in por_mac.items())), None)
        if not cid or cid in usados:
            base = f"cam_{ip.split('.')[-1]}"
            cid, k = base, 0
            ocupados = {v.get("id") for v in por_mac.values()}
            while cid in usados or cid in ocupados or (os.path.isdir(os.path.join(REC, cid)) and cid not in atual):
                k += 1
                cid = f"{base}{'bcdefghij'[k - 1] if k <= 9 else k}"
        usados.add(cid)
        nomes[ip] = cid
        if mac:
            mapa[mac] = {"id": cid, "ip": ip, "visto": time.strftime("%Y-%m-%d %H:%M")}
    return nomes, mapa

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
    macs = macs_da_varredura()
    nomes, mapa = nomear(ok, macs)
    # o que respondeu na porta da câmera mas não aceitou a senha: anota, para a varredura automática
    # não reconfigurar o sistema toda hora por causa desses aparelhos
    for ip in falhas:
        mac = macs.get(ip, "")
        if mac and not (mac in mapa and not mapa[mac].get("falhou")):
            mapa[mac] = {"falhou": True, "ip": ip, "visto": time.strftime("%Y-%m-%d %H:%M")}
    for ip in ok:
        n = nomes[ip]
        L += [f"  {n}:", f"    - {rtsp(pw, ip, 0)}", f"  {n}_sub:", f"    - {rtsp(pw, ip, 1)}"]
    open(YAML, "w").write("\n".join(L) + "\n")
    try:
        salvar_mapa(mapa)
    except Exception as e:
        print(f"aviso: não salvei o mapa de câmeras: {e}")
    os.chmod(YAML, 0o600)
    subprocess.run([sys.executable, os.path.join(HERE, "gen_config.py")], check=False)
    print(f"Configuradas {len(ok)} câmera(s): {', '.join(f'{nomes[ip]}={ip}' for ip in ok)}")

if __name__ == "__main__":
    main()
