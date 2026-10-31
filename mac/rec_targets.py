#!/usr/bin/env python3
# imprime "camid ip" das câmeras (streams principais) usando go2rtc.yaml + scan/cameras.json
import json, re, os
HERE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))  # dados/config ficam em app/
ids, inside = [], False
for line in open(os.path.join(HERE, "go2rtc.yaml")):
    if line.startswith("streams:"): inside = True; continue
    if inside and re.match(r"^\S", line): inside = False
    m = re.match(r"^  ([\w-]+):", line)
    if inside and m and not m.group(1).endswith("_sub"):
        ids.append(m.group(1))
ips = []
try:
    ips = [h["ip"] for h in json.load(open(os.path.join(HERE, "scan", "cameras.json")))["hosts"]]
except Exception:
    pass
for cid in ids:
    suf = cid.split("_")[-1]
    ip = next((x for x in ips if x.endswith("." + suf)), "")
    if ip:
        print(cid, ip)
