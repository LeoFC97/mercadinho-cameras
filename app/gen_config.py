#!/usr/bin/env python3
# Gera ui/config.js com a lista de câmeras (streams principais do go2rtc.yaml) + IP.
import json, re, os
HERE = os.path.dirname(os.path.abspath(__file__))
ids, inside = [], False
for line in open(os.path.join(HERE, "go2rtc.yaml")):
    if line.startswith("streams:"): inside = True; continue
    if inside and re.match(r"^\S", line): inside = False
    m = re.match(r"^  ([\w-]+):", line)
    if inside and m and not m.group(1).endswith("_sub"):
        ids.append(m.group(1))
ips = []
for fn in (os.path.join(HERE, "scan", "cameras.json"), os.path.join(HERE, "cameras_conhecidas.json")):
    try:
        d = json.load(open(fn))
        ips += [h["ip"] for h in d.get("hosts", [])] + d.get("provaveis_cameras", [])
    except Exception:
        pass
cams = []
for cid in ids:
    suf = cid.split("_")[-1]
    ip = next((x for x in ips if x.endswith("." + suf)), "")
    cams.append({"id": cid, "name": "Câmera " + suf, "ip": ip})
cfg = {"go2rtc": "auto", "cameras": cams}
out = os.path.join(HERE, "ui", "config.js")
with open(out, "w") as f:
    f.write("window.APP_CONFIG = " + json.dumps(cfg, ensure_ascii=False, indent=2) + ";\n")
print(f"{len(cams)} câmeras -> ui/config.js")
