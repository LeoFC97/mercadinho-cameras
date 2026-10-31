#!/usr/bin/env python3
# supervisor.py — mantém o sistema de câmeras vivo: go2rtc, painel web, gravadores (ffmpeg)
# e a manutenção (movimento/retenção). Reinicia o que cair. No Windows roda como tarefa no boot.
import os, sys, time, subprocess, re, json, socket, platform, signal, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = platform.system() == "Windows"
LOGD = os.path.join(HERE, "logs"); os.makedirs(LOGD, exist_ok=True)
REC = os.path.join(HERE, "ui", "rec"); os.makedirs(REC, exist_ok=True)

def load_env(path):
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.split("#", 1)[0].strip()
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
load_env(os.path.join(HERE, "gravador.env"))

PY = sys.executable
PYX = [PY, "-X", "utf8"]          # saída em UTF-8 também no Windows
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
GO2RTC = os.path.join(HERE, "go2rtc.exe" if IS_WIN else "go2rtc")
PORT = int(os.environ.get("PAINEL_PORTA", "8099"))
SEG = int(float(os.environ.get("SEG_SECONDS", "12")))
SUF = "_sub" if os.environ.get("REC_STREAM", "sub") == "sub" else ""
NOWIN = 0x08000000 if IS_WIN else 0   # CREATE_NO_WINDOW

def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    try:
        with open(os.path.join(LOGD, "supervisor.log"), "a", encoding="utf-8") as f: f.write(line + "\n")
    except Exception: pass

# --- uma instância só (trava numa porta local) ---
_lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    _lock.bind(("127.0.0.1", 18099))
except OSError:
    print("supervisor já está rodando."); sys.exit(0)

# --- Windows: job object -> se o supervisor morrer, os filhos morrem junto ---
if IS_WIN:
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    class BASIC(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
    class IOC(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("R", "W", "O", "RT", "WT", "OT")]
    class EXT(ctypes.Structure):
        _fields_ = [("Basic", BASIC), ("Io", IOC), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    JOB = k32.CreateJobObjectW(None, None)
    info = EXT(); info.Basic.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    k32.SetInformationJobObject(JOB, 9, ctypes.byref(info), ctypes.sizeof(info))
    if not k32.AssignProcessToJobObject(JOB, k32.GetCurrentProcess()):
        log(f"aviso: job object não aplicado (erro {ctypes.get_last_error()})")

def cams():
    out, inside = [], False
    for line in open(os.path.join(HERE, "go2rtc.yaml"), encoding="utf-8"):
        if line.startswith("streams:"): inside = True; continue
        if inside and re.match(r"^\S", line): inside = False
        m = re.match(r"^  ([\w-]+):", line)
        if inside and m and not m.group(1).endswith("_sub"): out.append(m.group(1))
    return out

class Proc:
    def __init__(self, name, args):
        self.name, self.args, self.p, self.restarts = name, args, None, 0
    def ensure(self):
        if self.p is not None and self.p.poll() is None:
            return
        if self.p is not None:
            self.restarts += 1
            log(f"{self.name} parou (código {self.p.returncode}); reiniciando [{self.restarts}]")
        lf = os.path.join(LOGD, self.name + ".log")
        if os.path.exists(lf) and os.path.getsize(lf) > 5_000_000:
            try: os.replace(lf, lf + ".old")
            except OSError: pass
        out = open(lf, "ab")
        self.p = subprocess.Popen(self.args, cwd=HERE, stdout=out, stderr=subprocess.STDOUT,
                                  stdin=subprocess.DEVNULL, creationflags=NOWIN)
        out.close()
    def stop(self):
        if self.p is not None and self.p.poll() is None:
            self.p.terminate()
            try: self.p.wait(5)
            except Exception: self.p.kill()

def go2rtc_ok():
    try:
        urllib.request.urlopen("http://127.0.0.1:1984/api/streams", timeout=2).read(); return True
    except Exception:
        return False

PEDIDOS = os.path.join(HERE, "pedidos"); os.makedirs(PEDIDOS, exist_ok=True)

def build_procs():
    """Monta a lista de processos a partir do go2rtc.yaml atual."""
    procs = [Proc("go2rtc", [GO2RTC, "-config", os.path.join(HERE, "go2rtc.yaml")])]
    procs[0].ensure()
    for _ in range(60):
        if go2rtc_ok(): break
        time.sleep(1)
    procs.append(Proc("painel", PYX + [os.path.join(HERE, "painel_server.py"), str(PORT)]))
    for cam in cams():
        os.makedirs(os.path.join(REC, cam), exist_ok=True)
        procs.append(Proc("grava_" + cam, [FFMPEG, "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp",
            "-i", f"rtsp://127.0.0.1:8554/{cam}{SUF}", "-an", "-c", "copy", "-f", "segment",
            "-segment_time", str(SEG), "-reset_timestamps", "1", "-strftime", "1",
            "-segment_format_options", "movflags=+faststart",   # índice no começo: abre mais rápido na Revisão
            os.path.join(REC, cam, "%Y%m%d_%H%M%S.mp4")]))
    procs.append(Proc("manutencao", PYX + [os.path.join(HERE, "gravador.py")]))
    return procs

def reconfigurar():
    """Procura as câmeras de novo, testa a senha e gera a configuração (roda como SYSTEM, lê senha.txt)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    env.setdefault("FFPROBE", os.path.join(HERE, "bin", "ffprobe.exe" if IS_WIN else "ffprobe"))
    lf = os.path.join(LOGD, "reconfigurar.log")
    with open(lf, "a", encoding="utf-8") as out:
        out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + "===== reconfigurar (pelo supervisor): início =====\n"); out.flush()
        for args in (PYX + [os.path.join(HERE, "scan_cameras.py")],
                     PYX + [os.path.join(HERE, "setup_cameras.py"), "--senha-arquivo", os.path.join(HERE, "senha.txt")]):
            try:
                subprocess.run(args, cwd=HERE, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                               env=env, timeout=600, creationflags=NOWIN)
            except Exception as e:
                out.write(f"erro: {e}\n")
        out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + "===== reconfigurar: fim =====\n")

REPO = os.environ.get("REPO_GITHUB", "LeoFC97/mercadinho-cameras")
AUTO_UPDATE = os.environ.get("AUTO_UPDATE", "1") == "1"
UPDATE_EVERY = int(float(os.environ.get("UPDATE_EVERY_MIN", "10"))) * 60
VERSAO = os.path.join(HERE, "versao.txt")          # sha do último commit instalado
NAO_SOBRESCREVER = {"senha.txt", "go2rtc.yaml", "gravador.env", "cameras_conhecidas.json", "versao.txt", "config.js"}

def _http(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "mercadinho-cameras", "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def commit_remoto():
    try:
        return json.loads(_http(f"https://api.github.com/repos/{REPO}/commits/main"))["sha"]
    except Exception as e:
        log(f"atualização: não consegui consultar o GitHub ({type(e).__name__})"); return None

def atualizar(sha=None):
    """Baixa o zip do branch main e copia app/ por cima (sem tocar em senha, config e gravações)."""
    import zipfile, io, shutil
    sha = sha or commit_remoto()
    lf = os.path.join(LOGD, "atualizar.log")
    def w(m):
        with open(lf, "a", encoding="utf-8") as f: f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + m + "\n")
    w(f"===== atualizar: início (commit {sha or '?'}) =====")
    try:
        data = _http(f"https://github.com/{REPO}/archive/refs/heads/main.zip", timeout=120)
        z = zipfile.ZipFile(io.BytesIO(data))
        n = 0
        for info in z.infolist():
            parts = info.filename.split("/")
            if len(parts) < 3 or parts[1] != "app" or info.is_dir(): continue
            rel = "/".join(parts[2:])
            if parts[2] in ("scan", "logs", "pedidos", "dados") or rel.startswith("ui/rec/") or rel.startswith("ui/clipes/"): continue
            if os.path.basename(rel) in NAO_SOBRESCREVER: continue
            dest = os.path.join(HERE, *parts[2:])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            novo = z.read(info)
            try: atual = open(dest, "rb").read()
            except OSError: atual = None
            if atual != novo:
                with open(dest, "wb") as f: f.write(novo)
                w(f"  atualizado: {rel}"); n += 1
        if sha: open(VERSAO, "w").write(sha)
        w(f"===== atualizar: fim — {n} arquivo(s) alterado(s) =====")
        log(f"atualização aplicada: {n} arquivo(s) (commit {(sha or '')[:7]})")
        return n
    except Exception as e:
        w(f"ERRO: {type(e).__name__}: {e}"); log(f"atualização falhou: {e}"); return None

def _hash_self():
    import hashlib
    try: return hashlib.sha1(open(os.path.abspath(__file__), "rb").read()).hexdigest()
    except OSError: return ""

def versao_local():
    try: return open(VERSAO).read().strip()
    except OSError: return ""

def pedido():
    """Lê e consome um pedido deixado pelo painel/atalho: 'reconfigurar', 'reiniciar' ou 'atualizar'."""
    for nome in ("atualizar", "reconfigurar", "reiniciar"):
        p = os.path.join(PEDIDOS, nome)
        if os.path.exists(p):
            try: os.remove(p)
            except OSError: pass
            return nome
    return None

def main():
    log(f"supervisor iniciando ({platform.system()}) em {HERE}")
    procs = build_procs()

    def bye(*_):
        log("supervisor encerrando"); [p.stop() for p in reversed(procs)]; sys.exit(0)
    signal.signal(signal.SIGTERM, bye); signal.signal(signal.SIGINT, bye)

    ultima_checagem = 0
    while True:
        ped = pedido()
        # checagem automática do GitHub: se o commit mudou, atualiza e reinicia
        if not ped and AUTO_UPDATE and time.time() - ultima_checagem > UPDATE_EVERY:
            ultima_checagem = time.time()
            sha = commit_remoto()
            if sha and sha != versao_local():
                log(f"nova versão no GitHub ({sha[:7]}); atualizando")
                ped = "atualizar"
        if ped:
            log(f"pedido recebido: {ped}")
            if ped == "atualizar":
                antes = _hash_self()
                n = atualizar()
                if not n:          # falhou ou nada mudou: não precisa reiniciar
                    ped = None
                elif _hash_self() != antes:
                    # o próprio supervisor mudou: encerra com erro para o Agendador de Tarefas
                    # relançá-lo em ~1 min com o código novo (os filhos morrem junto e voltam com ele)
                    log("supervisor.py atualizado; saindo para ser relançado pela tarefa agendada")
                    for p in reversed(procs): p.stop()
                    sys.exit(1)
            if ped:
                for p in reversed(procs): p.stop()
                if ped == "reconfigurar": reconfigurar()
                procs = build_procs()
                log(f"sistema reiniciado ({ped}); câmeras: {', '.join(cams())}")
        for p in procs:
            try: p.ensure()
            except Exception as e: log(f"falha ao iniciar {p.name}: {e}")
        st = {"atualizado": time.strftime("%Y-%m-%d %H:%M:%S"),
              "processos": {p.name: {"rodando": p.p is not None and p.p.poll() is None, "reinicios": p.restarts} for p in procs}}
        try:
            with open(os.path.join(LOGD, "status.json"), "w", encoding="utf-8") as f: json.dump(st, f, indent=1)
        except Exception: pass
        time.sleep(5)

if __name__ == "__main__":
    main()
