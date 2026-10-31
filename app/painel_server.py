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

# integração com o market4u (vendas) — sessão e planilhas ficam em dados/, fora da pasta servida
DADOS = os.path.join(HERE, "dados")
_m4u = None
def m4u():
    global _m4u
    if _m4u is None:
        import market4u
        _m4u = market4u.Market4u(DADOS)
    return _m4u

_oc = _cl = None
def ocorr():
    global _oc
    if _oc is None:
        import ocorrencias
        _oc = ocorrencias.Ocorrencias(DADOS)
    return _oc
def clipes_srv():
    global _cl
    if _cl is None:
        import clipes
        _cl = clipes.Clipes(HERE, REC, os.path.join(UI, "clipes"))
    return _cl

def _dia_param(path):
    from urllib.parse import urlparse, parse_qs
    from datetime import date, datetime as _dt
    q = parse_qs(urlparse(path).query)
    v = (q.get("dia") or [""])[0]
    if not v: return date.today()
    if not DAY_RE.match(v): raise ValueError("dia inválido")
    return _dt.strptime(v, "%Y-%m-%d").date()

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

PEDIDOS = os.path.join(HERE, "pedidos")
LOGD = os.path.join(HERE, "logs")

def _tail(path, n=40):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 16000))
            lines = f.read().decode("utf-8", "replace").splitlines()
        return lines[-n:]
    except OSError:
        return []

def sistema_status():
    """status.json do supervisor + pedidos pendentes + fim dos logs de reconfiguração/supervisor."""
    try: st = json.load(open(os.path.join(LOGD, "status.json"), encoding="utf-8"))
    except Exception: st = {}
    pend = [n for n in ("atualizar", "reconfigurar", "reiniciar") if os.path.exists(os.path.join(PEDIDOS, n))]
    cams = _cams_config()
    try: versao = open(os.path.join(HERE, "versao.txt")).read().strip()
    except OSError: versao = ""
    return {"status": st, "pendentes": pend, "cameras": cams, "versao": versao[:7],
            "atualizar_log": _tail(os.path.join(LOGD, "atualizar.log"), 30),
            "reconfigurar_log": _tail(os.path.join(LOGD, "reconfigurar.log"), 60),
            "supervisor_log": _tail(os.path.join(LOGD, "supervisor.log"), 12)}

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
        clean = self.path.split("?")[0]
        if clean == "/api/disk":
            try: return self._json(200, disk_report())
            except Exception as e: return self._json(500, {"erro": str(e)})
        if clean == "/api/sistema":
            try: return self._json(200, sistema_status())
            except Exception as e: return self._json(500, {"erro": str(e)})
        if clean.startswith("/api/vendas"):
            return self._vendas_get(clean)
        if clean in ("/api/analise", "/api/ocorrencias", "/api/clipes") or clean.startswith("/api/clipes/"):
            return self._oc_get(clean)
        return super().do_GET()
    # ---- análise movimento x vendas, ocorrências e clipes ----
    def _oc_get(self, clean):
        try:
            if clean == "/api/analise":
                import analise
                return self._json(200, analise.analise_dia(REC, _cams_config(), _dia_param(self.path), m4u()))
            if clean == "/api/ocorrencias":
                import ocorrencias
                return self._json(200, {"ocorrencias": ocorr().listar(), "clipes": clipes_srv().listar(),
                                        "status": [{"id": k, "rotulo": ocorrencias.ROTULO[k]} for k in ocorrencias.STATUS]})
            if clean == "/api/clipes":
                return self._json(200, {"clipes": clipes_srv().listar()})
            m = clipes_srv().obter(clean.rsplit("/", 1)[1])
            return self._json(200, m) if m else self._json(404, {"erro": "clipe não encontrado"})
        except ValueError as e:
            return self._json(400, {"erro": str(e)})
        except Exception as e:
            return self._json(500, {"erro": f"erro inesperado: {e}"})
    def _oc_post(self, clean):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}") if n else {}
            parts = clean.strip("/").split("/")          # api, ocorrencias|clipes, [id], [acao]
            if parts[1] == "clipes":
                if len(parts) == 2:
                    m = clipes_srv().pedir(req.get("t0"), req.get("t1"), req.get("cameras") or _cams_config(),
                                           req.get("nomes"), req.get("titulo", ""), req.get("autor", ""))
                    return self._json(200, m)
                if len(parts) == 4 and parts[3] == "apagar":
                    clipes_srv().apagar(parts[2]); return self._json(200, {"ok": True})
            if parts[1] == "ocorrencias":
                if len(parts) == 2:
                    o = ocorr().criar(req)
                    gc = req.get("clipe")
                    if gc:
                        c = clipes_srv().pedir(gc.get("t0"), gc.get("t1"), gc.get("cameras") or o["cameras"] or _cams_config(),
                                               gc.get("nomes"), o["titulo"], o["autor"], ocorrencia=o["id"])
                        o = ocorr().definir_clipe(o["id"], c["id"])
                    return self._json(200, o)
                if len(parts) == 3:
                    return self._json(200, ocorr().atualizar(parts[2], req))
                if len(parts) == 4 and parts[3] == "apagar":
                    o = ocorr().obter(parts[2])
                    ocorr().apagar(parts[2])
                    if o and o.get("clipe") and req.get("apagar_clipe", True):
                        try: clipes_srv().apagar(o["clipe"])
                        except KeyError: pass
                    return self._json(200, {"ok": True})
                if len(parts) == 4 and parts[3] == "clipe":
                    o = ocorr().obter(parts[2])
                    if not o: raise KeyError("ocorrência não encontrada")
                    c = clipes_srv().pedir(req.get("t0"), req.get("t1"), req.get("cameras") or o["cameras"] or _cams_config(),
                                           req.get("nomes"), o["titulo"], req.get("autor", ""), ocorrencia=o["id"])
                    return self._json(200, ocorr().definir_clipe(o["id"], c["id"]))
            return self._json(404, {"erro": "não encontrado"})
        except KeyError as e:
            return self._json(404, {"erro": str(e).strip("'\"")})
        except ValueError as e:
            return self._json(400, {"erro": str(e)})
        except Exception as e:
            return self._json(500, {"erro": f"erro inesperado: {e}"})
    # ---- vendas (market4u) ----
    def _vendas_get(self, clean):
        import market4u
        try:
            if clean == "/api/vendas/status":
                return self._json(200, m4u().status())
            if clean == "/api/vendas":
                return self._json(200, m4u().vendas(_dia_param(self.path)))
            if clean == "/api/vendas/planilha":
                dia = _dia_param(self.path)
                p = m4u().planilha(dia)
                if not p: return self._json(404, {"erro": "planilha desse dia ainda não foi baixada"})
                raw = open(p, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=windows-1252")
                self.send_header("Content-Disposition", f'attachment; filename="vendas-{dia:%Y-%m-%d}.csv"')
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
                return
            return self._json(404, {"erro": "não encontrado"})
        except market4u.PrecisaLogin as e:
            return self._json(401, {"erro": str(e), "precisa_login": True})
        except (market4u.Market4uErro, ValueError) as e:
            return self._json(502, {"erro": str(e)})
        except Exception as e:
            return self._json(500, {"erro": f"erro inesperado: {e}"})
    def _vendas_post(self, clean):
        import market4u
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}") if n else {}
            if clean == "/api/vendas/login":
                r = m4u().login(req.get("usuario", ""), req.get("senha", ""), req.get("mfa", ""),
                                req.get("authenticator", ""), bool(req.get("lembrar", True)))
                return self._json(200, r)
            if clean == "/api/vendas/sair":
                m4u().sair()
                return self._json(200, {"ok": True})
            return self._json(404, {"erro": "não encontrado"})
        except (market4u.Market4uErro, ValueError) as e:
            return self._json(502, {"ok": False, "erro": str(e), "msg": str(e)})
        except Exception as e:
            return self._json(500, {"ok": False, "erro": f"erro inesperado: {e}", "msg": str(e)})
    def do_POST(self):
        clean = self.path.split("?")[0]
        if clean.startswith("/api/vendas/"):
            return self._vendas_post(clean)
        if clean.startswith("/api/ocorrencias") or clean.startswith("/api/clipes"):
            return self._oc_post(clean)
        if clean in ("/api/sistema/reconfigurar", "/api/sistema/reiniciar", "/api/sistema/atualizar"):
            # deixa um pedido para o supervisor (que roda como SYSTEM) — sem precisar de administrador
            try:
                os.makedirs(PEDIDOS, exist_ok=True)
                open(os.path.join(PEDIDOS, clean.rsplit("/", 1)[1]), "w").write(str(time.time()))
                return self._json(200, {"ok": True, "pedido": clean.rsplit("/", 1)[1]})
            except Exception as e:
                return self._json(500, {"erro": str(e)})
        if clean == "/api/disk/delete":
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
