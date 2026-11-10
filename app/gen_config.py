#!/usr/bin/env python3
# Gera ui/config.js com a lista de câmeras (streams principais do go2rtc.yaml) + IP.
import json, re, os
HERE = os.path.dirname(os.path.abspath(__file__))
ids, inside, ip_de, atual = [], False, {}, ""
for line in open(os.path.join(HERE, "go2rtc.yaml"), encoding="utf-8"):
    if line.startswith("streams:"): inside = True; continue
    if inside and re.match(r"^\S", line): inside = False
    m = re.match(r"^  ([\w-]+):", line)
    if inside and m:
        atual = m.group(1)
        if not atual.endswith("_sub"):
            ids.append(atual)
    m2 = re.search(r"@([\d.]+):554", line)
    if inside and m2 and atual and not atual.endswith("_sub"):
        ip_de[atual] = m2.group(1)      # IP de verdade (o nome da câmera fica fixo mesmo se o IP mudar)
ips = []
for fn in (os.path.join(HERE, "scan", "cameras.json"), os.path.join(HERE, "cameras_conhecidas.json")):
    try:
        d = json.load(open(fn, encoding="utf-8"))
        ips += [h["ip"] for h in d.get("hosts", [])] + d.get("provaveis_cameras", [])
    except Exception:
        pass
cams = []
for cid in ids:
    suf = cid.split("_")[-1]
    ip = ip_de.get(cid) or next((x for x in ips if x.endswith("." + suf)), "")
    cams.append({"id": cid, "name": "Câmera " + suf, "ip": ip})
cfg = {"go2rtc": "auto", "cameras": cams}
out = os.path.join(HERE, "ui", "config.js")
with open(out, "w", encoding="utf-8") as f:
    f.write("window.APP_CONFIG = " + json.dumps(cfg, ensure_ascii=False, indent=2) + ";\n")
print(f"{len(cams)} câmeras -> ui/config.js")
