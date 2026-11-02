#!/usr/bin/env python3
# leve.py — versão leve dos trechos gravados, para a Revisão pela internet fraca.
# /leve/<câmera>/<arquivo>.mp4 = o mesmo trecho de ui/rec, convertido na hora para 320 px, 10 q/s e
# ~150 kbit/s (umas 3-4x menor). Gera sob demanda, já adianta os 2 próximos trechos e guarda em ui/leve/
# (cache descartável: some sozinho depois de 2 dias ou quando o original é apagado).
import os, re, shutil, time, threading, subprocess
from concurrent.futures import ThreadPoolExecutor

IS_WIN = os.name == "nt"
NOME = re.compile(r"^/leve/([\w-]{1,64})/(\d{8}_\d{6}\.mp4)$")


class Leve:
    def __init__(self, here, rec_dir):
        self.here, self.rec = here, rec_dir
        self.dir = os.path.join(here, "ui", "leve")
        os.makedirs(self.dir, exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=2)       # no máx. 2 conversões ao mesmo tempo
        self.lock = threading.Lock()
        self.fazendo = {}                                   # destino -> Future
        self.ult_limpeza = 0

    def _ffmpeg(self):
        f = os.environ.get("FFMPEG")
        if f and (os.path.isfile(f) or shutil.which(f)):
            return f
        local = os.path.join(self.here, "bin", "ffmpeg.exe" if IS_WIN else "ffmpeg")
        return local if os.path.isfile(local) else "ffmpeg"

    def _converter(self, src, dst):
        if os.path.isfile(dst):
            return True
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst[:-4] + ".tmp.mp4"
        args = [self._ffmpeg(), "-nostdin", "-v", "error", "-y", "-threads", "2", "-i", src, "-an",
                "-vf", "scale=320:-2,fps=10"]
        if os.environ.get("LEVE_VP9") == "1":     # só para testes (navegador de teste sem H.264)
            args += ["-c:v", "libvpx-vp9", "-b:v", "110k", "-deadline", "realtime", "-cpu-used", "8"]
        else:
            args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "31", "-maxrate", "120k", "-bufsize", "240k"]
        args += ["-g", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp]
        kw = {"creationflags": 0x08000000 | 0x00004000} if IS_WIN else {}
        try:
            p = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=60, **kw)
        except subprocess.TimeoutExpired:
            return False
        if p.returncode == 0 and os.path.isfile(tmp):
            os.replace(tmp, dst)
            return True
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False

    def _pedir(self, cam, f):
        src = os.path.join(self.rec, cam, f)
        dst = os.path.join(self.dir, cam, f)
        if os.path.isfile(dst) or not os.path.isfile(src):
            return None
        with self.lock:
            fut = self.fazendo.get(dst)
            if fut is None or fut.done():
                fut = self.pool.submit(self._converter, src, dst)
                self.fazendo[dst] = fut
        return fut

    def garantir(self, path):
        """Chamado pelo painel antes de servir /leve/...: converte se ainda não existe e adianta os próximos."""
        m = NOME.match(path.split("?")[0])
        if not m:
            return
        cam, f = m.group(1), m.group(2)
        fut = self._pedir(cam, f)
        if fut is not None:
            try:
                fut.result(timeout=40)
            except Exception:
                pass
        # adianta os 2 trechos seguintes desta câmera
        try:
            nomes = sorted(x for x in os.listdir(os.path.join(self.rec, cam)) if x.endswith(".mp4"))
            i = nomes.index(f)
            for prox in nomes[i + 1:i + 3]:
                self._pedir(cam, prox)
        except (OSError, ValueError):
            pass
        self._limpar()

    def _limpar(self):
        """Apaga do cache (só de ui/leve) o que tem mais de 2 dias ou cujo original já não existe."""
        if time.time() - self.ult_limpeza < 3600:
            return
        self.ult_limpeza = time.time()
        base = os.path.realpath(self.dir) + os.sep
        for cam in os.listdir(self.dir):
            d = os.path.join(self.dir, cam)
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                p = os.path.join(d, f)
                if not os.path.realpath(p).startswith(base):
                    continue
                try:
                    velho = time.time() - os.path.getmtime(p) > 2 * 86400
                    if velho or not os.path.isfile(os.path.join(self.rec, cam, f.replace(".tmp.mp4", ".mp4"))):
                        os.remove(p)
                except OSError:
                    pass
