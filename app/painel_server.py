#!/usr/bin/env python3
# painel_server.py — serve a pasta ui/ (painel + gravações) com tipos MIME certos e sem log por requisição.
# Também expõe a API de disco (/api/disk) usada pela tela "Disco" do painel para apagar gravações.
import sys, os, re, json, shutil, functools, time, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
REC = os.path.join(UI, "rec")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099

CAM_RE = re.compile(r"^[\w-]{1,64}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SEG_RE = re.compile(r"^(\d{8})_(\d{6})\.mp4$")
_lock = threading.Lock()

def _env_float(name, default):
    try: return float(os.environ.get(name, default))
    except Exception: return float(default)

def _cams_config():
    """Câmeras do go2rtc.yaml (as ativas)."""
    out, inside = [], False
    try:
        for line in open(os.path.join(HERE, "go2rtc.yaml"), encoding="utf-8"):
            if line.startswith("streams:"): inside = True; continue
            if inside and re.match(r"^\S", line): inside = False
            m = re.match(r"^  ([\w-]+):", line)
            if inside and m and not m.group(1).endswith("_sub"): out.append(m.group(1))
    except OSError:
        pass
    return out

def _day_of_seg(fname):
    m = SEG_RE.match(fname)
    return f"{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]}" if m else None

def _load_index(cam, day):
    p = os.path.join(REC, cam, f"{day}.json")
    try: return json.load(open(p, encoding="utf-8"))
    except Exception: return {}

def _save_index(cam, day, idx):
    p = os.path.join(REC, cam, f"{day}.json")
    if not idx:
        try: os.remove(p)
        except OSError: pass
        return
    tmp = p + ".tmp"
    json.dump(idx, open(tmp, "w"))
    os.replace(tmp, p)

def disk_report():
    """Uso de disco por câmera e por dia, mais pastas órfãs (câmeras que não estão mais na configuração)."""
    active = _cams_config()
    cams, days = [], {}
    if os.path.isdir(REC):
        for cam in sorted(os.listdir(REC)):
            d = os.path.join(REC, cam)
            if not os.path.isdir(d) or not CAM_RE.match(cam): continue
            per_day = {}
            total = 0
            for f in os.listdir(d):
                day = _day_of_seg(f)
                if not day: continue
                try: sz = os.path.getsize(os.path.join(d, f))
                except OSError: continue
                e = per_day.setdefault(day, {"day": day, "bytes": 0, "segs": 0})
                e["bytes"] += sz; e["segs"] += 1; total += sz
            for day, e in per_day.items():
                idx = _load_index(cam, day)
                e["motion"] = sum(1 for v in idx.values() if isinstance(v, dict) and v.get("m", 0) >= 1.6)
                t = days.setdefault(day, {"day": day, "bytes": 0, "segs": 0, "cams": {}})
                t["bytes"] += e["bytes"]; t["segs"] += e["segs"]; t["cams"][cam] = e["bytes"]
            cams.append({"id": cam, "active": cam in active, "bytes": total,
                         "days": sorted(per_day.values(), key=lambda x: x["day"])})
    try:
        du = shutil.disk_usage(REC if os.path.isdir(REC) else HERE)
        disk = {"total_gb": round(du.total / 1e9, 1), "free_gb": round(du.free / 1e9, 1)}
    except Exception:
        disk = {"total_gb": None, "free_gb": None}
    disk["used_gb"] = round(sum(c["bytes"] for c in cams) / 1e9, 2)
    disk["cap_gb"] = _env_float("CAP_GB", 18)
    disk["retention_hours"] = _env_float("RETENTION_HOURS", 72)
    disk["floor_gb"] = _env_float("FREE_FLOOR_GB", 12)
    return {"updated": round(time.time(), 1), "disk": disk, "cams": cams,
            "days": sorted(days.values(), key=lambda x: x["day"])}

def disk_delete(req):
    """req: {"cam": id|None, "day": "YYYY-MM-DD"|None, "older_than_days": N|None, "orphan": id|None}
    Apaga só dentro de ui/rec. Retorna bytes e arquivos removidos."""
    cam = req.get("cam"); day = req.get("day"); older = req.get("older_than_days"); orphan = req.get("orphan")
    if cam is not None and not CAM_RE.match(str(cam)): raise ValueError("câmera inválida")
    if day is not None and not DAY_RE.match(str(day)): raise ValueError("dia inválido")
    if orphan is not None and not CAM_RE.match(str(orphan)): raise ValueError("pasta inválida")
    freed = 0; files = 0
    with _lock:
        if orphan:
            if orphan in _cams_config(): raise ValueError("essa câmera está ativa; apague por dia")
            d = os.path.join(REC, orphan)
            if os.path.realpath(d).startswith(os.path.realpath(REC) + os.sep) and os.path.isdir(d):
                for root, _, fs in os.walk(d):
                    for f in fs:
                        try: freed += os.path.getsize(os.path.join(root, f)); files += 1
                        except OSError: pass
                shutil.rmtree(d, ignore_errors=True)
            return {"freed_bytes": freed, "files": files}
        cutoff_day = None
        if older is not None:
            older = int(older)
            if older < 0: raise ValueError("dias inválidos")
            cutoff_day = time.strftime("%Y-%m-%d", time.localtime(time.time() - older * 86400))
        if day is None and cutoff_day is None: raise ValueError("informe dia ou older_than_days")
        targets = [cam] if cam else [c for c in os.listdir(REC) if CAM_RE.match(c) and os.path.isdir(os.path.join(REC, c))]
        today = time.strftime("%Y-%m-%d")
        for c in targets:
            d = os.path.join(REC, c)
            if not os.path.isdir(d): continue
            touched = {}
            names = sorted(f for f in os.listdir(d) if SEG_RE.match(f))
            inprogress = names[-1] if names else None   # o último pode estar sendo gravado
            for f in names:
                fd = _day_of_seg(f)
                if day is not None and fd != day: continue
                if cutoff_day is not None and fd >= cutoff_day: continue
                if f == inprogress and fd == today: continue
                p = os.path.join(d, f)
                try:
                    sz = os.path.getsize(p); os.remove(p); freed += sz; files += 1
                except OSError: continue
                touched.setdefault(fd, _load_index(c, fd)).pop(f, None)
            for fd, idx in touched.items():
                _save_index(c, fd, idx)
    return {"freed_bytes": freed, "files": files}

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".html": "text/html; charset=utf-8", ".json": "application/json",
        ".mp4": "video/mp4", ".svg": "image/svg+xml", "": "application/octet-stream"}
    _range_left = None
    def log_message(self, *a):  # silencioso
        pass
    # ---- API ----
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.split("?")[0] == "/api/disk":
            try: return self._json(200, disk_report())
            except Exception as e: return self._json(500, {"erro": str(e)})
        return super().do_GET()
    def do_POST(self):
        if self.path.split("?")[0] == "/api/disk/delete":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(n) or b"{}")
                res = disk_delete(req)
                res["disk"] = disk_report()["disk"]
                return self._json(200, res)
            except ValueError as e:
                return self._json(400, {"erro": str(e)})
            except Exception as e:
                return self._json(500, {"erro": str(e)})
        self.send_error(404)
    # ---- arquivos ----
    def send_head(self):
        # suporte a Range (Safari/iPhone exige p/ vídeo; seek em arquivos grandes)
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m or (not m.group(1) and not m.group(2)):
            return super().send_head()
        size = os.path.getsize(path)
        if m.group(1):
            start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
        else:
            start = max(0, size - int(m.group(2))); end = size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers()
            return None
        f = open(path, "rb"); f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_left = end - start + 1
        return f
    def copyfile(self, source, outputfile):
        left = self._range_left
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(65536, left))
            if not chunk: break
            outputfile.write(chunk); left -= len(chunk)
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        # índice/manifest de gravações sempre fresco
        clean = self.path.split("?")[0]
        if clean.startswith("/rec/") and clean.endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        elif not clean.endswith(".mp4") and not clean.startswith("/vendor/"):
            # painel (html/js/css/config) sempre revalidado: uma atualização aparece no próximo F5
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), functools.partial(Handler, directory=UI))
    print(f"painel em http://0.0.0.0:{PORT}  (pasta {UI})", flush=True)
    srv.serve_forever()
