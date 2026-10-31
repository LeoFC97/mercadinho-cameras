#!/usr/bin/env python3
# clipes.py — exporta um trecho das gravações como UM vídeo MP4 com as câmeras em mosaico,
# nome de cada câmera e data/hora na imagem (para mandar no WhatsApp, anexar em B.O., etc.).
# Os clipes ficam em ui/clipes/ (servidos pelo painel) com um .json de informações ao lado.
# Roda um clipe por vez, em segundo plano e com prioridade baixa (não atrapalha a gravação).
import os, re, json, time, math, queue, threading, subprocess, secrets, shutil
from datetime import datetime

IS_WIN = os.name == "nt"
TILE_W, TILE_H, FPS = 640, 360, 15
MAX_S = 300                      # até 5 minutos por clipe

FONTES = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
          "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
          "/Library/Fonts/Arial.ttf"]


def _ffmpeg(here):
    f = os.environ.get("FFMPEG")
    if f and (os.path.isfile(f) or shutil.which(f)):
        return f
    local = os.path.join(here, "bin", "ffmpeg.exe" if IS_WIN else "ffmpeg")
    if os.path.isfile(local):
        return local
    if os.path.isfile("/opt/homebrew/bin/ffmpeg"):
        return "/opt/homebrew/bin/ffmpeg"
    return "ffmpeg"


def _fonte():
    for f in FONTES:
        if os.path.isfile(f):
            return f.replace("\\", "/").replace(":", "\\:")
    return None


def _esc_txt(s):
    # texto do drawtext: sem caracteres que quebram o filtro
    s = str(s).replace("'", "’")
    s = re.sub(r"[\\:%,;\[\]=]", " ", s)
    return re.sub(r"\s+", " ", s).strip()[:40] or "camera"


def _indices_periodo(rec_dir, cam, t0, t1):
    segs = []
    dias = {datetime.fromtimestamp(t0).strftime("%Y-%m-%d"), datetime.fromtimestamp(t1).strftime("%Y-%m-%d")}
    for d in sorted(dias):
        try:
            raw = json.load(open(os.path.join(rec_dir, cam, f"{d}.json"), encoding="utf-8"))
        except Exception:
            continue
        for f, v in raw.items():
            if v["t"] < t1 and v["t"] + v.get("d", 12) > t0:
                segs.append({"f": f, **v})
    return sorted(segs, key=lambda s: s["t"])


def montar_pedacos(rec_dir, cam, t0, t1):
    """Lista de pedaços que cobrem [t0,t1]: ('arq', caminho, inicio, dur) ou ('vazio', dur)."""
    out, cur = [], t0
    for s in _indices_periodo(rec_dir, cam, t0, t1):
        path = os.path.join(rec_dir, cam, s["f"])
        if not os.path.isfile(path):
            continue
        a = max(s["t"], cur)
        b = min(s["t"] + s.get("d", 12), t1)
        if b - a < 0.3:
            continue
        if a > cur + 0.05:
            out.append(("vazio", a - cur))
        out.append(("arq", path, a - s["t"], b - a))
        cur = b
    if cur < t1 - 0.05:
        out.append(("vazio", t1 - cur))
    return out


def comando(here, rec_dir, cams, nomes, t0, t1, saida):
    dur = t1 - t0
    n = len(cams)
    cols = 1 if n == 1 else 2 if n <= 4 else 3
    rows = math.ceil(n / cols)
    fonte = _fonte()
    args = [_ffmpeg(here), "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    filtros, k, tem_video = [], 0, False
    for ci, cam in enumerate(cams):
        pecas = montar_pedacos(rec_dir, cam, t0, t1)
        rotulos = []
        for pi, p in enumerate(pecas):
            lab = f"c{ci}p{pi}"
            if p[0] == "arq":
                _, path, ini, d = p
                args += ["-ss", f"{ini:.3f}", "-t", f"{d:.3f}", "-i", path]
                filtros.append(f"[{k}:v]fps={FPS},scale={TILE_W}:{TILE_H}:force_original_aspect_ratio=decrease,"
                               f"pad={TILE_W}:{TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
                               f"trim=duration={d:.3f},setpts=PTS-STARTPTS[{lab}]")
                k += 1
                tem_video = True
            else:
                filtros.append(f"color=c=0x101418:s={TILE_W}x{TILE_H}:r={FPS}:d={p[1]:.3f},setsar=1[{lab}]")
            rotulos.append(f"[{lab}]")
        tile = f"t{ci}"
        nome = _esc_txt(nomes.get(cam) or cam)
        txt = (f",drawtext=fontfile='{fonte}':text='{nome}':fontcolor=white:fontsize=20:"
               f"box=1:boxcolor=black@0.55:boxborderw=6:x=10:y=h-th-12") if fonte else ""
        filtros.append(f"{''.join(rotulos)}concat=n={len(rotulos)}:v=1:a=0,format=yuv420p{txt}[{tile}]")
    for extra in range(n, cols * rows):          # completa a grade com quadro vazio
        filtros.append(f"color=c=0x101418:s={TILE_W}x{TILE_H}:r={FPS}:d={dur:.3f},format=yuv420p,setsar=1[t{extra}]")
    total = cols * rows
    if total == 1:
        filtros.append("[t0]null[m]")
    else:
        layout = "|".join(f"{(i % cols) * TILE_W}_{(i // cols) * TILE_H}" for i in range(total))
        filtros.append("".join(f"[t{i}]" for i in range(total)) + f"xstack=inputs={total}:layout={layout}[m]")
    if fonte:
        filtros.append(f"[m]drawtext=fontfile='{fonte}':text='%{{pts\\:localtime\\:{int(t0)}}}':"
                       f"fontcolor=white:fontsize=24:box=1:boxcolor=black@0.6:boxborderw=8:x=12:y=12[out]")
    else:
        filtros.append("[m]null[out]")
    args += ["-filter_complex", ";".join(filtros), "-map", "[out]", "-t", f"{dur:.3f}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
             "-threads", "2", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", saida]
    return args, tem_video


class Clipes:
    def __init__(self, here, rec_dir, clipes_dir, ao_terminar=None):
        self.here, self.rec, self.dir = here, rec_dir, clipes_dir
        os.makedirs(clipes_dir, exist_ok=True)
        self.fila = queue.Queue()
        self.lock = threading.Lock()
        self.ao_terminar = ao_terminar
        # clipes que estavam na fila quando o painel reiniciou: refaz
        for m in self._todos():
            if m.get("status") in ("na fila", "gerando"):
                m["status"] = "na fila"; m["progresso"] = 0
                self._salvar(m); self.fila.put(m["id"])
        threading.Thread(target=self._trabalhar, daemon=True).start()

    def _meta_path(self, cid):
        return os.path.join(self.dir, cid + ".json")

    def _salvar(self, m):
        tmp = self._meta_path(m["id"]) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False)
        os.replace(tmp, self._meta_path(m["id"]))

    def obter(self, cid):
        if not re.match(r"^[\w-]{1,64}$", cid or ""):
            return None
        try:
            return json.load(open(self._meta_path(cid), encoding="utf-8"))
        except Exception:
            return None

    def _todos(self):
        out = []
        for f in os.listdir(self.dir):
            if f.endswith(".json"):
                m = self.obter(f[:-5])
                if m:
                    out.append(m)
        return out

    def listar(self):
        return sorted(self._todos(), key=lambda m: m.get("criado_em", 0), reverse=True)

    def pedir(self, t0, t1, cams, nomes=None, titulo="", autor="", ocorrencia=None):
        t0, t1 = float(t0), float(t1)
        if t1 <= t0:
            raise ValueError("o fim do clipe precisa ser depois do início")
        if t1 - t0 > MAX_S:
            raise ValueError(f"clipe muito longo (máximo {MAX_S // 60} minutos)")
        cams = [c for c in cams if re.match(r"^[\w-]{1,64}$", c)]
        if not cams:
            raise ValueError("escolha pelo menos uma câmera")
        cid = time.strftime("%Y%m%d-%H%M%S", time.localtime(t0)) + "-" + secrets.token_hex(3)
        m = {"id": cid, "t0": t0, "t1": t1, "cams": cams, "nomes": {c: str((nomes or {}).get(c, c))[:40] for c in cams},
             "titulo": str(titulo or "")[:120], "autor": str(autor or "")[:60], "ocorrencia": ocorrencia,
             "criado_em": time.time(), "status": "na fila", "progresso": 0, "arquivo": None, "erro": None}
        self._salvar(m)
        self.fila.put(cid)
        return m

    def apagar(self, cid):
        m = self.obter(cid)
        if not m:
            raise KeyError("clipe não encontrado")
        for p in (os.path.join(self.dir, cid + ".mp4"), self._meta_path(cid)):
            try:
                os.remove(p)
            except OSError:
                pass

    def _trabalhar(self):
        while True:
            cid = self.fila.get()
            m = self.obter(cid)
            if not m or m.get("status") not in ("na fila", "gerando"):
                continue
            try:
                self._gerar(m)
            except Exception as e:
                m["status"], m["erro"] = "erro", str(e)[:400]
                self._salvar(m)
            if self.ao_terminar:
                try:
                    self.ao_terminar(m)
                except Exception:
                    pass

    def _gerar(self, m):
        m["status"], m["progresso"] = "gerando", 0
        self._salvar(m)
        final = os.path.join(self.dir, m["id"] + ".mp4")
        tmp = os.path.join(self.dir, m["id"] + ".parcial.mp4")
        args, tem_video = comando(self.here, self.rec, m["cams"], m["nomes"], m["t0"], m["t1"], tmp)
        if not tem_video:
            raise RuntimeError("não há gravação nesse horário (pode já ter sido apagada pela limpeza)")
        dur = m["t1"] - m["t0"]
        kw = {}
        if IS_WIN:
            kw["creationflags"] = 0x08000000 | 0x00004000      # sem janela, prioridade abaixo do normal
        else:
            kw["preexec_fn"] = lambda: os.nice(10)
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                             text=True, encoding="utf-8", errors="replace", **kw)
        ultimo = 0
        for line in p.stdout:
            if line.startswith("out_time_ms=") or line.startswith("out_time_us="):
                try:
                    pct = min(99, int(int(line.split("=")[1]) / 1e6 / dur * 100))
                except ValueError:
                    continue
                if pct >= ultimo + 5:
                    ultimo = pct; m["progresso"] = pct; self._salvar(m)
        err = p.stderr.read()
        p.wait()
        if p.returncode != 0 or not os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise RuntimeError("ffmpeg falhou: " + (err.strip().splitlines() or ["?"])[-1][:300])
        os.replace(tmp, final)
        m.update(status="pronto", progresso=100, arquivo=f"/clipes/{m['id']}.mp4",
                 tamanho=os.path.getsize(final), pronto_em=time.time())
        self._salvar(m)
