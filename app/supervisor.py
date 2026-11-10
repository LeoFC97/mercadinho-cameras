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

def rec_suf():
    """Lê o REC_STREAM atual do gravador.env (a cada reinício: o painel pode trocar entre sub e HD)."""
    v = os.environ.get("REC_STREAM", "sub")
    try:
        for line in open(os.path.join(HERE, "gravador.env"), encoding="utf-8"):
            line = line.split("#", 1)[0].strip()
            if line.startswith("REC_STREAM="):
                v = line.split("=", 1)[1].strip()
    except OSError:
        pass
    return "" if v == "main" else "_sub"
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

BAIXA = 0x00004000 if IS_WIN else 0   # BELOW_NORMAL_PRIORITY_CLASS: análise cede a vez para gravação e painel

class Proc:
    def __init__(self, name, args, baixa=False):
        self.name, self.args, self.p, self.restarts, self.baixa = name, args, None, 0, baixa
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
        kw = {"creationflags": NOWIN | (BAIXA if self.baixa else 0)}
        if not IS_WIN and self.baixa:
            kw["preexec_fn"] = lambda: os.nice(10)
        self.p = subprocess.Popen(self.args, cwd=HERE, stdout=out, stderr=subprocess.STDOUT,
                                  stdin=subprocess.DEVNULL, **kw)
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
    suf = rec_suf()
    for cam in cams():
        os.makedirs(os.path.join(REC, cam), exist_ok=True)
        procs.append(Proc("grava_" + cam, [FFMPEG, "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp",
            "-i", f"rtsp://127.0.0.1:8554/{cam}{suf}", "-an", "-c", "copy", "-f", "segment",
            "-segment_time", str(SEG), "-reset_timestamps", "1", "-strftime", "1",
            "-segment_format_options", "movflags=+faststart",   # índice no começo: abre mais rápido na Revisão
            os.path.join(REC, cam, "%Y%m%d_%H%M%S.mp4")]))
    procs.append(Proc("manutencao", PYX + [os.path.join(HERE, "gravador.py")], baixa=True))
    procs.append(Proc("prateleiras", PYX + [os.path.join(HERE, "prateleiras.py")], baixa=True))   # zonas: o que saiu da prateleira
    return procs

def reconfigurar(varrer=True):
    """Procura as câmeras de novo (opcional), testa a senha e gera a configuração (roda como SYSTEM, lê senha.txt)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    env.setdefault("FFPROBE", os.path.join(HERE, "bin", "ffprobe.exe" if IS_WIN else "ffprobe"))
    lf = os.path.join(LOGD, "reconfigurar.log")
    with open(lf, "a", encoding="utf-8") as out:
        out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + "===== reconfigurar (pelo supervisor): início =====\n"); out.flush()
        passos = ([PYX + [os.path.join(HERE, "scan_cameras.py")]] if varrer else []) + \
                 [PYX + [os.path.join(HERE, "setup_cameras.py"), "--senha-arquivo", os.path.join(HERE, "senha.txt")]]
        for args in passos:
            try:
                subprocess.run(args, cwd=HERE, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                               env=env, timeout=600, creationflags=NOWIN)
            except Exception as e:
                out.write(f"erro: {e}\n")
        out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + "===== reconfigurar: fim =====\n")

REPO = os.environ.get("REPO_GITHUB", "LeoFC97/mercadinho-cameras")
AUTO_UPDATE = os.environ.get("AUTO_UPDATE", "1") == "1"
AUTO_SCAN = os.environ.get("AUTO_SCAN", "1") == "1"
SCAN_EVERY = int(float(os.environ.get("SCAN_EVERY_MIN", "15"))) * 60

def _ip_configurado():
    """{id: ip} das câmeras no go2rtc.yaml de agora."""
    out, atual = {}, ""
    try:
        for line in open(os.path.join(HERE, "go2rtc.yaml"), encoding="utf-8"):
            m = re.match(r"^  ([\w-]+):\s*$", line)
            if m: atual = m.group(1)
            m2 = re.search(r"@([\d.]+):554", line)
            if m2 and atual and not atual.endswith("_sub"): out[atual] = m2.group(1)
    except Exception:
        pass
    return out

def camera_nova():
    """Varre a rede (scan_cameras.py) e devolve o que pede reconfigurar: câmera nova (MAC nunca visto) ou
    câmera conhecida que o roteador mudou de IP. Câmera que sumiu NÃO conta (pode ser queda momentânea),
    e aparelho que já recusou a senha também não (senão o sistema reiniciaria a cada varredura)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        subprocess.run(PYX + [os.path.join(HERE, "scan_cameras.py")], cwd=HERE, capture_output=True,
                       stdin=subprocess.DEVNULL, env=env, timeout=300, creationflags=NOWIN)
        scan = json.load(open(os.path.join(HERE, "scan", "cameras.json"), encoding="utf-8"))
        achadas = scan.get("provaveis_cameras", [])
        macs = {h["ip"]: (h.get("mac") or "").upper() for h in scan.get("hosts", [])}
    except Exception as e:
        log(f"varredura automática falhou: {type(e).__name__}: {e}"); return []
    try:
        mapa = json.load(open(os.path.join(HERE, "dados", "cameras_mac.json"), encoding="utf-8"))
    except Exception:
        mapa = {}
    conf = _ip_configurado()
    ips_conf = set(conf.values())
    mudou = []
    for ip in achadas:
        mac = macs.get(ip, "")
        info = mapa.get(mac) if mac else None
        if info and info.get("falhou"):
            continue                                   # já recusou a senha: não é câmera nossa
        if info and info.get("id") in conf:
            if conf[info["id"]] != ip:
                mudou.append(f"{ip} ({info['id']} mudou de IP)")
            continue
        if ip not in ips_conf:
            mudou.append(ip)
    return mudou

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

ALTERADOS = []   # arquivos trocados na última atualização

# o que reiniciar conforme o arquivo que mudou (gravação e go2rtc NÃO param numa atualização comum)
MODULOS_PAINEL = {"painel_server.py", "market4u.py", "analise.py", "ocorrencias.py", "clipes.py", "ia.py",
                  "leve.py", "diagnostico.py", "prateleiras.py"}

def quem_reiniciar(alterados):
    alvo = set()
    for rel in alterados:
        base = rel.split("/")[-1]
        if rel.startswith("ui/") or not base.endswith(".py"):
            continue                              # painel web/arquivos: o navegador pega no próximo F5
        if base in MODULOS_PAINEL: alvo.add("painel")
        if base == "gravador.py": alvo.add("manutencao")
        if base == "prateleiras.py": alvo.add("prateleiras")
        if base in ("scan_cameras.py", "setup_cameras.py", "gen_config.py", "reconfigurar.py", "servidor_24h.py"):
            continue                              # só rodam quando pedidos
        if base not in MODULOS_PAINEL and base not in ("gravador.py", "prateleiras.py", "supervisor.py",
                                                       "scan_cameras.py", "setup_cameras.py", "gen_config.py",
                                                       "reconfigurar.py", "servidor_24h.py"):
            alvo |= {"painel", "manutencao", "prateleiras"}   # módulo novo/desconhecido: reinicia a análise e o painel
    return alvo

def atualizar(sha=None):
    ALTERADOS.clear()
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
            if parts[2] in ("scan", "logs", "pedidos", "dados") or rel.startswith(("ui/rec/", "ui/clipes/", "ui/leve/")): continue
            if os.path.basename(rel) in NAO_SOBRESCREVER: continue
            dest = os.path.join(HERE, *parts[2:])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            novo = z.read(info)
            try: atual = open(dest, "rb").read()
            except OSError: atual = None
            if atual != novo:
                with open(dest, "wb") as f: f.write(novo)
                w(f"  atualizado: {rel}"); n += 1; ALTERADOS.append(rel)
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

def otimizar_windows():
    """Ajustes leves do Windows para o notebook trabalhar como gravador (a cada início):
    - a pesquisa do Windows não indexa as gravações (milhares de arquivos novos por dia);
    - plano de energia de alto desempenho (o notebook fica na tomada).
    Desligue com OTIMIZAR_WINDOWS=0 no gravador.env."""
    if not IS_WIN or os.environ.get("OTIMIZAR_WINDOWS", "1") != "1":
        return
    for d in (os.path.join(HERE, "ui", "rec"), os.path.join(HERE, "dados"), os.path.join(HERE, "ui", "clipes")):
        if os.path.isdir(d):
            try:
                subprocess.run(["attrib", "+I", d, "/S", "/D"], capture_output=True, timeout=300, creationflags=NOWIN)
                subprocess.run(["attrib", "+I", d], capture_output=True, timeout=30, creationflags=NOWIN)
            except Exception:
                pass
    log("otimização: pesquisa do Windows não indexa as gravações")
    try:
        r = subprocess.run(["powercfg", "/setactive", "SCHEME_MIN"], capture_output=True, timeout=30, creationflags=NOWIN)
        log("otimização: plano de energia alto desempenho" if r.returncode == 0 else "otimização: plano alto desempenho indisponível neste notebook")
    except Exception:
        pass

def main():
    log(f"supervisor iniciando ({platform.system()}) em {HERE}")
    try: otimizar_windows()
    except Exception as e: log(f"otimização do Windows falhou: {e}")
    procs = build_procs()

    def bye(*_):
        log("supervisor encerrando"); [p.stop() for p in reversed(procs)]; sys.exit(0)
    signal.signal(signal.SIGTERM, bye); signal.signal(signal.SIGINT, bye)

    ultima_checagem = 0
    ultima_varredura = time.time() - SCAN_EVERY + 60   # primeira varredura ~1 min após subir; depois a cada SCAN_EVERY
    espera_falha = 180                                  # varredura extra quando a gravação de uma câmera fica caindo
    while True:
        ped = pedido()
        # varredura automática: câmera nova na rede -> reconfigura e passa a gravar, sem ninguém clicar
        # gravação de alguma câmera caindo sem parar (ex.: o roteador trocou o IP dela): varre já, sem esperar
        # os 15 min — no máximo uma vez a cada 3 min
        caindo = [p.name for p in procs if p.name.startswith("grava_") and p.restarts - getattr(p, "_rest_base", 0) >= 6]
        por_falha = False
        if caindo and AUTO_SCAN and time.time() - ultima_varredura > espera_falha:
            log(f"gravação falhando em {', '.join(caindo)}; procurando as câmeras na rede agora")
            for p in procs: p._rest_base = p.restarts
            ultima_varredura, por_falha = time.time() - SCAN_EVERY - 1, True
        if not ped and AUTO_SCAN and time.time() - ultima_varredura > SCAN_EVERY:
            ultima_varredura = time.time()
            novas = camera_nova()
            # câmera desligada não volta com varredura: espaça as varreduras por falha (3 → 6 → 12 → 15 min)
            espera_falha = 180 if novas else (min(900, espera_falha * 2) if por_falha else espera_falha)
            if novas:
                log(f"câmera(s) nova(s) na rede: {', '.join(novas)}; reconfigurando")
                for p in reversed(procs): p.stop()
                reconfigurar(varrer=False)
                procs = build_procs()
                log(f"sistema reiniciado (câmera nova); câmeras: {', '.join(cams())}")
                continue
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
                else:
                    # atualização comum: reinicia só o que mudou — gravação e go2rtc continuam
                    alvo = quem_reiniciar(ALTERADOS)
                    for p in procs:
                        if p.name in alvo:
                            p.stop(); p.p = None
                    log(f"atualização aplicada sem parar a gravação; reiniciado: {', '.join(sorted(alvo)) or 'nada'}")
                    ped = None
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
