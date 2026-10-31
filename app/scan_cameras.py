#!/usr/bin/env python3
# scan_cameras.py — localiza câmeras IP (Intelbras Mibo iM3 C) na rede local do Mac.
# Faz: ping sweep -> tabela ARP -> varredura de portas (RTSP/ONVIF/Intelbras) -> sondagem RTSP -> descoberta ONVIF (WS-Discovery).
import socket, subprocess, json, re, sys, os, ipaddress, uuid, time, platform
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "scan")
os.makedirs(OUT_DIR, exist_ok=True)

PORTS = [554, 80, 443, 8080, 8000, 37777, 34567, 8899, 1935]
TIMEOUT = 0.7
RTSP_PATH = "/cam/realmonitor?channel=1&subtype=0"

# Palpite de fabricante pelo prefixo MAC (apenas indicativo)
OUI_HINTS = {
    "00:1A:3F": "Intelbras", "58:10:8C": "Intelbras",
    "3C:EF:8C": "Dahua/ODM", "4C:11:BF": "Dahua/ODM", "A0:BD:1D": "Dahua/ODM",
    "E0:50:8B": "Dahua/ODM", "9C:14:63": "Dahua/ODM", "BC:32:5F": "Dahua/ODM",
    "08:ED:ED": "Dahua/ODM", "38:AF:29": "Dahua/ODM", "24:52:6A": "Dahua/ODM",
    "FC:5F:49": "Dahua/ODM", "6C:1C:71": "Dahua/ODM", "A4:D5:C2": "Dahua/ODM",
}

IS_LINUX = platform.system() == "Linux"
IS_WINDOWS = platform.system() == "Windows"

def sh(cmd, timeout=10):
    # Lê a saída como bytes e decodifica de forma tolerante: no Windows, comandos como
    # `arp -a` respondem na codificação do console (CP850, com acentos em português) e
    # não em UTF-8 — decodificar como texto derrubava a varredura inteira.
    try:
        kw = {"creationflags": 0x08000000} if IS_WINDOWS else {}
        out = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout, **kw).stdout or b""
    except Exception:
        return ""
    for enc in (("cp850", "utf-8") if IS_WINDOWS else ("utf-8",)):
        try:
            return out.decode(enc)
        except UnicodeDecodeError:
            continue
    return out.decode("utf-8", errors="replace")

def default_iface():
    if IS_LINUX:
        m = re.search(r"default via \S+ dev (\S+)", sh("ip route show default"))
        return m.group(1) if m else None
    m = re.search(r"interface:\s*(\S+)", sh("route -n get default"))
    return m.group(1) if m else None

SKIP_IF = r"^(lo|utun|awdl|llw|gif|stf|bridge|vmnet|vnic|ap|docker|br-|veth|tailscale|virbr|zt)"

def primary_ip():
    # IP local usado para sair à internet (não envia nada; só consulta a rota)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]; s.close(); return ip
    except Exception:
        return None

def local_networks():
    nets = []
    if IS_WINDOWS:
        ip = primary_ip()
        if ip and not ip.startswith("127.") and not ip.startswith("169.254.") and not ip.startswith("100."):
            nets.append({"iface": "principal", "ip": ip, "network": str(ipaddress.ip_network(f"{ip}/24", strict=False))})
        return nets, "principal"
    if IS_LINUX:
        for line in sh("ip -4 -o addr show").splitlines():
            m = re.match(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)", line)
            if not m: continue
            iface, ip, prefix = m.group(1), m.group(2), int(m.group(3))
            if ip.startswith("127.") or ip.startswith("169.254.") or re.match(SKIP_IF, iface): continue
            nets.append({"iface": iface, "ip": ip, "network": str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False))})
    else:
        cur = None
        for line in sh("ifconfig").splitlines():
            m = re.match(r"^(\w+):", line)
            if m:
                cur = m.group(1); continue
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-fA-F]+)", line)
            if m and cur:
                ip = m.group(1); mask = int(m.group(2), 16)
                if ip.startswith("127.") or ip.startswith("169.254."): continue
                if re.match(SKIP_IF, cur): continue
                prefix = bin(mask).count("1")
                nets.append({"iface": cur, "ip": ip, "network": str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False))})
    d = default_iface()
    nets.sort(key=lambda n: 0 if n["iface"] == d else 1)
    return nets, d

def ping(ip):
    if IS_WINDOWS: args = ["ping", "-n", "1", "-w", "500", ip]
    elif IS_LINUX: args = ["ping", "-c", "1", "-W", "1", "-q", ip]
    else: args = ["ping", "-c", "1", "-W", "400", "-q", ip]
    try:
        kw = {"creationflags": 0x08000000} if IS_WINDOWS else {}
        subprocess.run(args, capture_output=True, timeout=3, **kw)
    except Exception:
        pass

def arp_table():
    table = {}
    if IS_WINDOWS:
        for line in sh("arp -a").splitlines():
            m = re.match(r"^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F-]{17})\s", line)
            if m: table[m.group(1)] = m.group(2).replace("-", ":").upper()
        return table
    if IS_LINUX:
        for line in sh("ip neigh show").splitlines():
            m = re.match(r"^(\d+\.\d+\.\d+\.\d+)\s.*lladdr\s+([0-9a-fA-F:]+)", line)
            if m: table[m.group(1)] = m.group(2).upper()
        return table
    for line in sh("arp -an").splitlines():
        m = re.search(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]+|\(incomplete\))", line)
        if m and m.group(2) != "(incomplete)":
            mac = ":".join(o.zfill(2).upper() for o in m.group(2).split(":"))
            table[m.group(1)] = mac
    return table

def tcp_open(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=TIMEOUT):
            return True
    except Exception:
        return False

def rtsp_probe(ip, port=554):
    info = {}
    try:
        with socket.create_connection((ip, port), timeout=2) as s:
            s.settimeout(2)
            req = (f"DESCRIBE rtsp://{ip}:{port}{RTSP_PATH} RTSP/1.0\r\nCSeq: 1\r\n"
                   f"User-Agent: scan_cameras\r\nAccept: application/sdp\r\n\r\n")
            s.sendall(req.encode())
            data = b""
            t0 = time.time()
            while time.time() - t0 < 2:
                try:
                    chunk = s.recv(4096)
                    if not chunk: break
                    data += chunk
                    if b"\r\n\r\n" in data: break
                except socket.timeout:
                    break
            txt = data.decode(errors="ignore")
            m = re.match(r"RTSP/1\.0 (\d+)", txt)
            if m: info["status"] = int(m.group(1))
            m = re.search(r"^Server:\s*(.+?)\r?$", txt, re.M | re.I)
            if m: info["server"] = m.group(1).strip()
            m = re.search(r'realm="([^"]*)"', txt)
            if m: info["realm"] = m.group(1)
    except Exception as e:
        info["erro"] = type(e).__name__
    return info

def ws_discovery(bind_ip, wait=3.0):
    found = {}
    probes = []
    for types in ("dn:NetworkVideoTransmitter", ""):
        types_xml = f"<d:Types>{types}</d:Types>" if types else ""
        probes.append(f'''<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>uuid:{uuid.uuid4()}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe>{types_xml}</d:Probe></e:Body></e:Envelope>''')
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((bind_ip, 0))
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(bind_ip))
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        for p in probes:
            s.sendto(p.encode(), ("239.255.255.250", 3702))
        s.settimeout(0.5)
        t0 = time.time()
        while time.time() - t0 < wait:
            try:
                data, addr = s.recvfrom(65535)
            except socket.timeout:
                continue
            txt = data.decode(errors="ignore")
            xaddrs = re.search(r"XAddrs>([^<]+)<", txt)
            scopes = re.search(r"Scopes>([^<]+)<", txt)
            urls = xaddrs.group(1).split() if xaddrs else []
            ip = addr[0]
            for u in urls:
                m = re.search(r"//(\d+\.\d+\.\d+\.\d+)", u)
                if m: ip = m.group(1); break
            sc = {}
            for item in (scopes.group(1).split() if scopes else []):
                m = re.search(r"onvif://www\.onvif\.org/(\w+)/(.+)", item)
                if m: sc.setdefault(m.group(1), []).append(m.group(2))
            found[ip] = {"xaddrs": urls, "scopes": sc}
        s.close()
    except Exception as e:
        print(f"  (WS-Discovery indisponível: {e})")
    return found

def main():
    print("=" * 72)
    print(f"Varredura de câmeras — {datetime.now():%d/%m/%Y %H:%M:%S} — host: {platform.node()}")
    print("=" * 72)
    nets, d = local_networks()
    if not nets:
        print("Nenhuma interface de rede ativa encontrada. O Mac está conectado ao Wi-Fi da loja?")
        sys.exit(1)
    print("Interfaces:")
    for n in nets:
        print(f"  {n['iface']:8s} {n['ip']:16s} rede {n['network']}" + ("   <- padrão" if n['iface'] == d else ""))
    target = nets[0]
    net = ipaddress.ip_network(target["network"])
    if net.num_addresses > 256:
        net = ipaddress.ip_network(f"{target['ip']}/24", strict=False)
        print(f"  (rede maior que /24; varrendo apenas {net})")
    hosts = [str(h) for h in net.hosts() if str(h) != target["ip"]]
    print(f"\n[1/4] Ping em {len(hosts)} endereços de {net} ...")
    with ThreadPoolExecutor(max_workers=64) as ex:
        list(ex.map(ping, hosts))
    arp = arp_table()
    alive = sorted([ip for ip in arp if ipaddress.ip_address(ip) in net], key=lambda x: int(ipaddress.ip_address(x)))
    print(f"      {len(alive)} dispositivos responderam (tabela ARP).")

    print(f"      Varredura direta da porta 554 em todos os {len(hosts)} endereços (pega câmera que não responde ping) ...")
    def rtsp_only(ip):
        return ip if tcp_open(ip, 554) else None
    with ThreadPoolExecutor(max_workers=128) as ex:
        extra = [ip for ip in ex.map(rtsp_only, hosts) if ip]
    novos = [ip for ip in extra if ip not in alive]
    if novos:
        print(f"      +{len(novos)} host(s) com 554 aberto que não estavam na ARP: {', '.join(novos)}")
        alive.extend(novos)
    print(f"[2/4] Descoberta ONVIF (WS-Discovery) ...")
    onvif = ws_discovery(target["ip"])
    print(f"      {len(onvif)} dispositivos ONVIF responderam.")
    for ip in onvif:
        if ip not in alive and ipaddress.ip_address(ip) in net:
            alive.append(ip)

    print(f"[3/4] Portas {PORTS} em {len(alive)} hosts ...")
    def scan_host(ip):
        return ip, [p for p in PORTS if tcp_open(ip, p)]
    with ThreadPoolExecutor(max_workers=128) as ex:
        ports = dict(ex.map(scan_host, alive))

    print(f"[4/4] Sondagem RTSP (porta 554) ...")
    rows = []
    for ip in alive:
        mac = arp.get(ip, "")
        oui = OUI_HINTS.get(mac[:8], "")
        r = {"ip": ip, "mac": mac, "fabricante_palpite": oui, "portas": ports.get(ip, []),
             "onvif": onvif.get(ip), "rtsp": rtsp_probe(ip) if 554 in ports.get(ip, []) else None}
        score = 0
        if 554 in r["portas"]: score += 3
        if r["onvif"]: score += 3
        if 37777 in r["portas"] or 34567 in r["portas"]: score += 2
        if r["rtsp"] and r["rtsp"].get("realm"): score += 2
        if oui: score += 1
        r["pontuacao_camera"] = score
        r["provavel_camera"] = score >= 3
        rows.append(r)

    print("\n" + "-" * 72)
    print(f"{'IP':16s} {'MAC':18s} {'Portas abertas':24s} Observações")
    print("-" * 72)
    for r in rows:
        obs = []
        if r["fabricante_palpite"]: obs.append(r["fabricante_palpite"])
        if r["onvif"]:
            sc = r["onvif"]["scopes"]
            obs.append("ONVIF" + (" " + " ".join(sc.get("name", []) + sc.get("hardware", [])) if sc else ""))
        if r["rtsp"]:
            if r["rtsp"].get("realm"): obs.append(f"RTSP realm='{r['rtsp']['realm']}'")
            elif r["rtsp"].get("server"): obs.append(f"RTSP {r['rtsp']['server']}")
            elif r["rtsp"].get("status"): obs.append(f"RTSP {r['rtsp']['status']}")
        flag = "** CÂMERA? **" if r["provavel_camera"] else ""
        print(f"{r['ip']:16s} {r['mac']:18s} {','.join(map(str, r['portas'])):24s} {flag} {' | '.join(obs)}")
    cams = [r for r in rows if r["provavel_camera"]]
    print("-" * 72)
    print(f"Prováveis câmeras: {len(cams)}  ->  " + ", ".join(r["ip"] for r in cams))
    sem_rtsp = [r["ip"] for r in cams if 554 not in r["portas"]]
    if sem_rtsp:
        print(f"Sem porta 554 (RTSP desligado no app Mibo?): {', '.join(sem_rtsp)}")

    print("\nFerramentas no Mac:")
    for t in ["ffmpeg", "ffprobe", "python3"]:
        print(f"  {t:8s} {sh(f'command -v {t}').strip() or '-'}")
    print(f"  sistema  {platform.system()} {platform.release()} ({platform.machine()})")

    result = {"quando": datetime.now().isoformat(timespec="seconds"), "interface": target, "rede": str(net),
              "hosts": rows, "provaveis_cameras": [r["ip"] for r in cams]}
    with open(os.path.join(OUT_DIR, "cameras.json"), "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nResultado salvo em {os.path.join(OUT_DIR, 'cameras.json')}")

if __name__ == "__main__":
    main()
