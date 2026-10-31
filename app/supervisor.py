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

def main():
    log(f"supervisor iniciando ({platform.system()}) em {HERE}")
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
            os.path.join(REC, cam, "%Y%m%d_%H%M%S.mp4")]))
    procs.append(Proc("manutencao", PYX + [os.path.join(HERE, "gravador.py")]))

    def bye(*_):
        log("supervisor encerrando"); [p.stop() for p in reversed(procs)]; sys.exit(0)
    signal.signal(signal.SIGTERM, bye); signal.signal(signal.SIGINT, bye)

    while True:
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
