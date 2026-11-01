#!/usr/bin/env python3
# prateleiras.py — zonas de interesse (prateleiras/geladeira), catálogo de itens por zona e o
# analisador que detecta quando alguém mexe numa zona e QUAL item mudou (comparando antes x depois).
#
# Como funciona (sem precisar da IA treinada, desde que cada produto tenha um lugar fixo):
#   1. Cada zona é um polígono desenhado sobre a foto da câmera; dentro dela, cada item é um retângulo.
#   2. O analisador lê os trechos gravados (ui/rec) em baixa resolução e cinza, mede o "movimento" dentro
#      de cada zona; quando começa, guarda o quadro de ANTES; quando a zona fica parada de novo, pega o DEPOIS.
#   3. Compara antes x depois em cada item: o que mudou bem mais que o resto da zona = item mexido.
#      Menos "textura" depois = provável retirada; mais = provável reposição.
#   4. Salva o evento (com recortes antes/depois) em dados/prateleiras/eventos/AAAA-MM-DD.json.
#
# Roda como processo próprio (o supervisor sobe):  python prateleiras.py
# Nada aqui apaga gravação; os dados ficam em dados/prateleiras/ (protegidos da limpeza).
import os, sys, re, json, time, math, glob, shutil, secrets, threading, subprocess
from datetime import datetime, date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(HERE, "ui", "rec")
DIR = os.path.join(HERE, "dados", "prateleiras")
CFG = os.path.join(DIR, "config.json")
EVD = os.path.join(DIR, "eventos")
IMG = os.path.join(DIR, "img")
ESTADO = os.path.join(DIR, "estado.json")
IS_WIN = os.name == "nt"

W, H = 320, 180            # resolução de análise
FPS = float(os.environ.get("PRAT_FPS", "2"))
ATIV_TH = float(os.environ.get("PRAT_ATIV_TH", "7"))        # diferença média (0-255) que conta como mexendo
CALMA_S = float(os.environ.get("PRAT_CALMA_S", "2.5"))     # zona parada por tanto tempo = acabou a interação
ITEM_TH = float(os.environ.get("PRAT_ITEM_TH", "12"))      # quanto o item precisa mudar além do resto da zona
OCUP_MAX = float(os.environ.get("PRAT_OCUP_MAX", "0.18"))  # fração da zona diferente do "antes" que ainda indica mão/pessoa na frente
MAX_INTER_S = float(os.environ.get("PRAT_MAX_S", "120"))   # interação mais longa que isso: fecha mesmo assim
MIN_M = float(os.environ.get("PRAT_MIN_M", "0.5"))         # trecho sem movimento (nota do gravador): não decodifica


def _ffmpeg():
    f = os.environ.get("FFMPEG")
    if f and (os.path.isfile(f) or shutil.which(f)):
        return f
    local = os.path.join(HERE, "bin", "ffmpeg.exe" if IS_WIN else "ffmpeg")
    if os.path.isfile(local):
        return local
    return "/opt/homebrew/bin/ffmpeg" if os.path.isfile("/opt/homebrew/bin/ffmpeg") else "ffmpeg"


def _kw():
    return {"creationflags": 0x08000000 | 0x00004000} if IS_WIN else {}


def _ler_json(p, padrao):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return padrao


def _gravar_json(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, p)


# ======================= configuração (zonas e itens) =======================
_lock = threading.RLock()


def config():
    c = _ler_json(CFG, {})
    c.setdefault("refs", {})
    c.setdefault("zonas", [])
    return c


def _salvar_config(c):
    c["alterado_em"] = time.time()
    _gravar_json(CFG, c)


def _pontos(v):
    pts = []
    for p in v or []:
        x, y = float(p[0]), float(p[1])
        pts.append([round(min(1, max(0, x)), 5), round(min(1, max(0, y)), 5)])
    if len(pts) < 3:
        raise ValueError("a zona precisa de pelo menos 3 pontos")
    return pts[:40]


def _item(d, zid):
    x, y, w, h = (min(1.0, max(0.0, float(d[k]))) for k in ("x", "y", "w", "h"))
    if w < 0.004 or h < 0.004:
        raise ValueError("item muito pequeno")
    cl = d.get("classe")
    return {"id": d.get("id") or "i" + secrets.token_hex(3), "zona": zid,
            "classe": int(cl) if cl not in (None, "") else None,
            "nome": str(d.get("nome") or "").strip()[:120], "barras": str(d.get("barras") or "").strip()[:40],
            "capacidade": int(d.get("capacidade") or 0),
            "x": round(x, 5), "y": round(y, 5), "w": round(min(w, 1 - x), 5), "h": round(min(h, 1 - y), 5)}


def salvar_zona(d):
    """Cria (sem id) ou atualiza uma zona inteira: {id?, cam, nome, pontos, itens:[...], sensibilidade}"""
    with _lock:
        c = config()
        zid = d.get("id") or "z" + secrets.token_hex(3)
        cam = str(d.get("cam") or "")
        if not re.match(r"^[\w-]{1,64}$", cam):
            raise ValueError("câmera inválida")
        z = {"id": zid, "cam": cam, "nome": str(d.get("nome") or "Prateleira").strip()[:80],
             "pontos": _pontos(d.get("pontos")),
             "sensibilidade": min(3.0, max(0.3, float(d.get("sensibilidade") or 1.0))),
             "itens": [_item(i, zid) for i in (d.get("itens") or [])][:200]}
        c["zonas"] = [x for x in c["zonas"] if x["id"] != zid] + [z]
        _salvar_config(c)
        return z


def apagar_zona(zid):
    with _lock:
        c = config()
        n = len(c["zonas"])
        c["zonas"] = [x for x in c["zonas"] if x["id"] != zid]
        if len(c["zonas"]) == n:
            raise KeyError("zona não encontrada")
        _salvar_config(c)


def foto_referencia(cam, rtsp_base=None):
    """Tira uma foto HD da câmera (stream principal) para desenhar as zonas em cima."""
    if not re.match(r"^[\w-]{1,64}$", cam or ""):
        raise ValueError("câmera inválida")
    base = rtsp_base or os.environ.get("IA_RTSP_BASE", "rtsp://127.0.0.1:8554")
    os.makedirs(DIR, exist_ok=True)
    out = os.path.join(DIR, f"ref_{cam}.jpg")
    tmp = out + ".novo.jpg"
    args = [_ffmpeg(), "-nostdin", "-v", "error", "-y"]
    if base.startswith("rtsp"):
        args += ["-rtsp_transport", "tcp"]
    args += ["-i", f"{base}/{cam}", "-frames:v", "1", "-q:v", "3", tmp]
    try:
        p = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=25, **_kw())
    except subprocess.TimeoutExpired:
        raise ValueError("a câmera não respondeu")
    if p.returncode or not os.path.isfile(tmp):
        raise ValueError("não consegui tirar a foto: " + (p.stderr.decode("utf-8", "replace").strip().splitlines() or ["?"])[-1][:200])
    os.replace(tmp, out)
    with _lock:
        c = config()
        c["refs"][cam] = {"arquivo": os.path.basename(out), "em": time.time()}
        _salvar_config(c)
    return c["refs"][cam]


# ======================= eventos (leitura para o painel) =======================
def eventos_dia(dia: str):
    return _ler_json(os.path.join(EVD, f"{dia}.json"), [])


def caminho_img(nome):
    if not re.match(r"^[\w.-]{1,120}\.jpg$", nome or ""):
        return None
    for d in (IMG, DIR):
        p = os.path.join(d, nome)
        if os.path.isfile(p):
            return p
    return None


def marcar_evento(dia, eid, d):
    """Atualiza um evento (ex.: 'conferido', 'ocorrencia')."""
    with _lock:
        lst = eventos_dia(dia)
        for e in lst:
            if e["id"] == eid:
                for k in ("conferido", "ocorrencia", "nota"):
                    if k in d:
                        e[k] = d[k]
                _gravar_json(os.path.join(EVD, f"{dia}.json"), lst)
                return e
    raise KeyError("evento não encontrado")


def reanalisar(dia: str):
    """Esquece o que já foi analisado nesse dia (o analisador passa de novo nos trechos que ainda existem)."""
    with _lock:
        st = _ler_json(ESTADO, {})
        ini = time.mktime(datetime.strptime(dia, "%Y-%m-%d").timetuple())
        for cam, v in list(st.items()):
            if isinstance(v, (int, float)) and v >= ini:
                st[cam] = ini - 1
        _gravar_json(ESTADO, st)
        ant = os.path.join(EVD, f"{dia}.json")
        if os.path.isfile(ant):
            os.replace(ant, ant + f".antes-{int(time.time())}")   # guarda o que havia (nada é apagado)


# ======================= analisador =======================
def _mascara_poligono(pts):
    """Índices (no quadro W x H) dos pixels dentro do polígono."""
    poly = [(x * W, y * H) for x, y in pts]
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    x0, x1 = max(0, int(min(xs))), min(W - 1, int(math.ceil(max(xs))))
    y0, y1 = max(0, int(min(ys))), min(H - 1, int(math.ceil(max(ys))))
    idx = []
    n = len(poly)
    for y in range(y0, y1 + 1):
        py = y + 0.5
        # cruzamentos da linha horizontal com as arestas
        cortes = []
        for i in range(n):
            ax, ay = poly[i]; bx, by = poly[(i + 1) % n]
            if (ay <= py < by) or (by <= py < ay):
                cortes.append(ax + (py - ay) * (bx - ax) / (by - ay))
        cortes.sort()
        for k in range(0, len(cortes) - 1, 2):
            for x in range(max(x0, int(math.ceil(cortes[k] - 0.5))), min(x1, int(cortes[k + 1] - 0.5)) + 1):
                idx.append(y * W + x)
    return idx


def _mascara_caixa(it, dentro=None):
    x0, y0 = int(it["x"] * W), int(it["y"] * H)
    x1, y1 = int(math.ceil((it["x"] + it["w"]) * W)), int(math.ceil((it["y"] + it["h"]) * H))
    idx = [y * W + x for y in range(max(0, y0), min(H, y1)) for x in range(max(0, x0), min(W, x1))]
    if dentro is not None:
        idx = [i for i in idx if i in dentro]
    return idx


def _media_dif(a, b, idx):
    if not idx:
        return 0.0
    s = 0
    for i in idx:
        d = a[i] - b[i]
        s += d if d > 0 else -d
    return s / len(idx)


def _fracao_dif(a, b, idx, lim=28):
    """Fração dos pixels que mudaram bastante (mão/pessoa ainda na frente da prateleira?)."""
    if not idx:
        return 0.0
    n = 0
    for i in idx:
        d = a[i] - b[i]
        if d > lim or d < -lim:
            n += 1
    return n / len(idx)


def _desvio(a, idx):
    if not idx:
        return 0.0
    v = [a[i] for i in idx]
    m = sum(v) / len(v)
    return math.sqrt(sum((x - m) ** 2 for x in v) / len(v))


class Zona:
    def __init__(self, z):
        self.z = z
        self.idx = _mascara_poligono(z["pontos"])
        self.sub = self.idx[::4] or self.idx               # amostra para medir movimento rápido
        dentro = set(self.idx)
        self.itens = [(it, _mascara_caixa(it, dentro) or _mascara_caixa(it)) for it in z.get("itens", [])]
        ocup = set(i for _, m in self.itens for i in m)
        self.fundo = [i for i in self.idx if i not in ocup] or self.idx
        self.th = ATIV_TH / float(z.get("sensibilidade") or 1.0)
        # estado da interação
        self.quieto = None          # (t, quadro) último quadro parado
        self.ini = None             # início da interação
        self.antes = None           # (t, quadro) antes de mexer
        self.ult_mov = None         # último instante com movimento
        self.pico = 0.0


class Analisador:
    def __init__(self):
        self.cfg_mtime = -1
        self.zonas = {}             # cam -> [Zona]
        self.prev = {}              # cam -> (t, quadro anterior)
        self.estado = _ler_json(ESTADO, {})

    def _recarregar(self):
        try:
            mt = os.path.getmtime(CFG)
        except OSError:
            mt = 0
        if mt == self.cfg_mtime:
            return
        self.cfg_mtime = mt
        c = config()
        novas = {}
        for z in c["zonas"]:
            try:
                novas.setdefault(z["cam"], []).append(Zona(z))
            except Exception as e:
                log(f"zona {z.get('id')} inválida: {e}")
        self.zonas = novas
        log(f"config carregada: {sum(len(v) for v in novas.values())} zona(s) em {len(novas)} câmera(s)")

    def _indice(self, cam, dia):
        """Índice do dia da câmera, relido só quando o arquivo muda."""
        p = os.path.join(REC, cam, dia + ".json")
        try:
            mt = os.path.getmtime(p)
        except OSError:
            return {}
        if not hasattr(self, "_idx"):
            self._idx = {}
        c = self._idx.get(p)
        if not c or c[0] != mt:
            c = (mt, _ler_json(p, {}))
            self._idx[p] = c
        return c[1]

    def _segmentos_novos(self, cam):
        desde = float(self.estado.get(cam, time.time() - float(os.environ.get("PRAT_DESDE_H", "3")) * 3600))
        segs = []
        hoje = date.today()
        for d in (hoje - timedelta(days=1), hoje):
            for f, v in self._indice(cam, d.strftime("%Y-%m-%d")).items():
                if v["t"] > desde + 0.5:
                    p = os.path.join(REC, cam, f)
                    if os.path.isfile(p):
                        segs.append((v["t"], v.get("d", 12), p, f, v.get("m", 99)))
        return sorted(segs)[:30]

    def _ultimo_quadro(self, path):
        """Só o último quadro do trecho (barato) — para trechos parados."""
        args = [_ffmpeg(), "-nostdin", "-v", "error", "-sseof", "-0.6", "-i", path, "-an", "-frames:v", "1",
                "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "pipe:1"]
        try:
            p = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, **_kw())
        except subprocess.TimeoutExpired:
            return None
        return p.stdout[:W * H] if len(p.stdout) >= W * H else None

    def _quadros(self, path):
        args = [_ffmpeg(), "-nostdin", "-v", "error", "-threads", "1", "-i", path, "-an",
                "-vf", f"fps={FPS},scale={W}:{H},format=gray", "-f", "rawvideo", "pipe:1"]
        try:
            p = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=90, **_kw())
        except subprocess.TimeoutExpired:
            return []
        n = W * H
        data = p.stdout
        return [data[i:i + n] for i in range(0, len(data) - n + 1, n)]

    def ciclo(self):
        self._recarregar()
        if not self.zonas:
            return 0
        feitos = 0
        for cam, zs in self.zonas.items():
            for t0, dur, path, fname, m in self._segmentos_novos(cam):
                if m < MIN_M and not any(z.ini for z in zs):
                    # trecho parado: não precisa decodificar tudo, só guarda o último quadro como "antes"
                    q = self._ultimo_quadro(path)
                    if q:
                        tf = t0 + max(0.0, dur - 0.5)
                        self.prev[cam] = (tf, q)
                        for z in zs:
                            z.quieto = (tf, q)
                    self.estado[cam] = t0
                    feitos += 1
                    continue
                qs = self._quadros(path)
                for k, q in enumerate(qs):
                    self._quadro(cam, zs, t0 + k / FPS, q, path, t0)
                self.estado[cam] = t0
                feitos += 1
        if feitos:
            _gravar_json(ESTADO, self.estado)
        return feitos

    def _quadro(self, cam, zs, t, q, path, seg_t):
        pv = self.prev.get(cam)
        self.prev[cam] = (t, q)
        if not pv or t - pv[0] > 30:          # buraco na gravação: recomeça o estado
            for z in zs:
                z.quieto, z.ini, z.antes, z.ult_mov = (t, q), None, None, None
            return
        for z in zs:
            ativ = _media_dif(q, pv[1], z.sub)
            if ativ >= z.th:
                if z.ini is None:
                    z.ini = t
                    z.antes = z.quieto or pv
                    z.pico = 0.0
                z.ult_mov = t
                z.pico = max(z.pico, ativ)
            else:
                if z.ini is None:
                    z.quieto = (t, q)
                elif t - z.ini > MAX_INTER_S or (
                        t - z.ult_mov >= CALMA_S and _fracao_dif(q, z.antes[1], z.sub) <= OCUP_MAX):
                    # parado E sem nada grande na frente (mão parada sobre o produto não conta como "acabou")
                    self._fechar(cam, z, (t, q), path, seg_t)
                    z.ini, z.quieto = None, (t, q)

    def _fechar(self, cam, z, depois, path, seg_t):
        antes = z.antes
        if not antes:
            return
        qa, qd = antes[1], depois[1]
        base = _media_dif(qa, qd, z.fundo)
        mudancas = []
        for it, m in z.itens:
            if not m:
                continue
            dif = _media_dif(qa, qd, m)
            if dif - base >= ITEM_TH and dif >= base * 1.8:
                sa, sd = _desvio(qa, m), _desvio(qd, m)
                tipo = "retirada" if sd < sa * 0.85 else "reposicao" if sd > sa * 1.15 else "mexido"
                mudancas.append({"item": it["id"], "classe": it.get("classe"), "nome": it.get("nome"),
                                 "barras": it.get("barras", ""), "tipo": tipo, "forca": round(dif - base, 1)})
        geral = _media_dif(qa, qd, z.idx)
        if not mudancas and geral < ITEM_TH * 0.6:
            return       # alguém passou na frente mas nada mudou: não vira evento
        mudancas.sort(key=lambda m: -m["forca"])
        dia = datetime.fromtimestamp(z.ini).strftime("%Y-%m-%d")
        eid = datetime.fromtimestamp(z.ini).strftime("%H%M%S") + "-" + secrets.token_hex(2)
        ev = {"id": eid, "cam": cam, "zona": z.z["id"], "zona_nome": z.z["nome"],
              "inicio": round(z.ini, 1), "fim": round(z.ult_mov or z.ini, 1),
              "antes_t": round(antes[0], 1), "depois_t": round(depois[0], 1),
              "mudancas": mudancas, "mudou": bool(mudancas), "geral": round(geral, 1), "pico": round(z.pico, 1),
              "img_antes": None, "img_depois": None}
        try:
            ev["img_antes"] = self._recorte(cam, z, antes[0], f"{dia}_{eid}_antes.jpg")
            ev["img_depois"] = self._recorte(cam, z, depois[0], f"{dia}_{eid}_depois.jpg")
        except Exception as e:
            log(f"recorte falhou: {e}")
        with _lock:
            lst = eventos_dia(dia)
            lst.append(ev)
            _gravar_json(os.path.join(EVD, f"{dia}.json"), lst)
        desc = ", ".join(f"{m['nome'] or m['item']} ({m['tipo']})" for m in mudancas) or "mudança sem item catalogado"
        log(f"{cam}/{z.z['nome']} {datetime.fromtimestamp(z.ini):%H:%M:%S}: {desc}")

    def _recorte(self, cam, z, t, nome):
        """Recorte da zona (com folga) no instante t, tirado da gravação, para mostrar antes/depois."""
        seg = None
        dia = datetime.fromtimestamp(t).strftime("%Y-%m-%d")
        raw = _ler_json(os.path.join(REC, cam, dia + ".json"), {})
        for f, v in raw.items():
            if v["t"] <= t < v["t"] + v.get("d", 12) + 0.3:
                seg = (os.path.join(REC, cam, f), t - v["t"])
        if not seg or not os.path.isfile(seg[0]):
            return None
        xs = [p[0] for p in z.z["pontos"]]; ys = [p[1] for p in z.z["pontos"]]
        fx, fy = 0.04, 0.06
        x0, x1 = max(0, min(xs) - fx), min(1, max(xs) + fx)
        y0, y1 = max(0, min(ys) - fy), min(1, max(ys) + fy)
        os.makedirs(IMG, exist_ok=True)
        out = os.path.join(IMG, nome)
        crop = f"crop=iw*{x1 - x0:.4f}:ih*{y1 - y0:.4f}:iw*{x0:.4f}:ih*{y0:.4f},scale='min(640,iw)':-2"
        subprocess.run([_ffmpeg(), "-nostdin", "-v", "error", "-y", "-ss", f"{max(0, seg[1]):.2f}", "-i", seg[0],
                        "-frames:v", "1", "-vf", crop, "-q:v", "3", out],
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=30, **_kw())
        return nome if os.path.isfile(out) else None


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    try:
        os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
        with open(os.path.join(HERE, "logs", "prateleiras.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def main():
    os.makedirs(EVD, exist_ok=True)
    log(f"analisador de prateleiras: {W}x{H} a {FPS} q/s, limiar {ATIV_TH}, item {ITEM_TH}")
    a = Analisador()
    while True:
        try:
            n = a.ciclo()
        except Exception as e:
            log(f"erro no ciclo: {type(e).__name__}: {e}")
            n = 0
        if "--uma-vez" in sys.argv:
            return
        time.sleep(2 if n else 8)


if __name__ == "__main__":
    main()
