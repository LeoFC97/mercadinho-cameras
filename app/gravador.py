#!/usr/bin/env python3
# gravador.py — manutenção da gravação: mede duração, pontua movimento, indexa,
# mantém só os trechos com movimento (+folga) e respeita o teto de disco.
# Roda em loop; os ffmpeg que segmentam são iniciados pelo gravador-run.sh / 5-gravador.command.
import os, sys, json, subprocess, time, re, shutil
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(HERE, "ui", "rec")           # servido pelo painel em /rec
FFPROBE = os.environ.get("FFPROBE") or ("/opt/homebrew/bin/ffprobe" if os.path.exists("/opt/homebrew/bin/ffprobe") else "ffprobe")
FFMPEG = os.environ.get("FFMPEG") or ("/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg")

# ---- parâmetros (ajustáveis) ----
SEG_SECONDS       = float(os.environ.get("SEG_SECONDS", "12"))       # duração alvo de cada segmento
MOTION_THRESHOLD  = float(os.environ.get("MOTION_THRESHOLD", "0.8"))      # YAVG médio do quadro-diferença p/ "movimento" (conservador: mantém mais)
SCORE_FPS         = float(os.environ.get("SCORE_FPS", "3"))        # amostragem p/ pontuar movimento
KEEP_MARGIN_SEGS  = int(float(os.environ.get("KEEP_MARGIN_SEGS", "2")))        # mantém N segmentos vizinhos de um com movimento (pré/pós)
CAP_GB            = float(os.environ.get("CAP_GB", "18.0"))     # tamanho máximo de ui/rec
FREE_FLOOR_GB     = float(os.environ.get("FREE_FLOOR_GB", "12.0"))     # nunca deixar o disco abaixo disso (apara os mais antigos)
RETENTION_HOURS   = float(os.environ.get("RETENTION_HOURS", "72"))       # descarta eventos mais antigos que isso
GRACE_HOURS       = float(os.environ.get("GRACE_HOURS", "2"))        # NUNCA poda por falta de movimento nas últimas N horas (segurança)
PROTEGE_ANTES_S   = float(os.environ.get("PROTEGE_ANTES_S", "420"))   # perto de venda/ocorrência: guarda 7 min antes...
PROTEGE_DEPOIS_S  = float(os.environ.get("PROTEGE_DEPOIS_S", "120"))  # ...e 2 min depois, mesmo sem movimento detectado
PAINEL_PORTA      = os.environ.get("PAINEL_PORTA", "8099")
LOOP_SECONDS      = float(os.environ.get("LOOP_SECONDS", "8"))

NOWIN = {"creationflags": 0x08000000} if os.name == "nt" else {}   # sem janela de console no Windows

TS_RE = re.compile(r"(\d{8})_(\d{6})\.mp4$")

def cams():
    out = []
    inside = False
    for line in open(os.path.join(HERE, "go2rtc.yaml")):
        if line.startswith("streams:"): inside = True; continue
        if inside and re.match(r"^\S", line): inside = False
        m = re.match(r"^  ([\w-]+):", line)
        if inside and m and not m.group(1).endswith("_sub"):
            out.append(m.group(1))
    return out

def seg_epoch(fname):
    m = TS_RE.search(fname)
    if not m: return None
    try:
        return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").timestamp()
    except Exception:
        return None

def day_of(epoch):
    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d")

def mp4_duracao(path):
    """Duração lida direto do cabeçalho do MP4 (átomo mvhd) — sem abrir um ffprobe por trecho."""
    import struct
    with open(path, "rb") as f:
        f.seek(0, 2); fim = f.tell(); pos = 0
        while pos + 8 <= fim:
            f.seek(pos)
            tam, tipo = struct.unpack(">I4s", f.read(8)); cab = 8
            if tam == 1:
                tam = struct.unpack(">Q", f.read(8))[0]; cab = 16
            elif tam == 0:
                tam = fim - pos
            if tam < cab:
                return None
            if tipo == b"moov":
                q, lim = pos + cab, pos + tam
                while q + 8 <= lim:
                    f.seek(q)
                    t2, ty2 = struct.unpack(">I4s", f.read(8))
                    if ty2 == b"mvhd":
                        ver = f.read(4)[0]
                        if ver == 1:
                            f.read(16); escala, dur = struct.unpack(">IQ", f.read(12))
                        else:
                            f.read(8); escala, dur = struct.unpack(">II", f.read(8))
                        return round(dur / escala, 2) if escala else None
                    if t2 < 8:
                        return None
                    q += t2
                return None
            pos += tam
    return None

def probe_dur(path):
    try:
        d = mp4_duracao(path)
        if d and d > 0:
            return d
    except Exception:
        pass
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", path], capture_output=True, text=True, timeout=20, **NOWIN)
        return round(float(r.stdout.strip()), 2)
    except Exception:
        return float(SEG_SECONDS)

def motion_score(path):
    # média do YAVG do quadro-diferença (quanto muda entre frames) ~ quantidade de movimento
    cmd = [FFMPEG, "-nostdin", "-v", "error", "-threads", "1", "-i", path,
           "-vf", f"fps={SCORE_FPS},tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
           "-an", "-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=40, **NOWIN)
    except Exception:
        return MOTION_THRESHOLD * 5
    vals = [float(x) for x in re.findall(r"YAVG=([0-9.]+)", r.stdout + r.stderr)]
    if not vals: return MOTION_THRESHOLD * 5   # não conseguiu medir -> trata como movimento (mantém)
    return round(sum(vals) / len(vals), 3)

# índices ficam em memória entre as voltas (relê só se o arquivo mudou por fora, ex.: tela Disco)
# e só são regravados quando mudam — antes eram lidos e regravados inteiros a cada 8 segundos.
_IDX = {}      # (cam, day) -> (mtime, dict)
_SIG = {}      # (cam, day) -> assinatura do que está gravado no arquivo

def _sig(idx):
    return (len(idx), hash(frozenset(idx)))

def load_index(cam, day):
    p = os.path.join(REC, cam, f"{day}.json")
    try:
        mt = os.path.getmtime(p)
    except OSError:
        _IDX.pop((cam, day), None); _SIG.pop((cam, day), None)
        return {}
    c = _IDX.get((cam, day))
    if c and c[0] == mt:
        return c[1]
    try:
        with open(p) as f: d = json.load(f)
    except Exception:
        d = {}
    _IDX[(cam, day)] = (mt, d); _SIG[(cam, day)] = _sig(d)
    return d

def save_index(cam, day, idx):
    p = os.path.join(REC, cam, f"{day}.json")
    if _SIG.get((cam, day)) == _sig(idx) and os.path.exists(p):
        return                                   # nada mudou: não regrava
    tmp = p + ".tmp"
    with open(tmp, "w") as f: json.dump(idx, f)
    os.replace(tmp, p)
    try: _IDX[(cam, day)] = (os.path.getmtime(p), idx); _SIG[(cam, day)] = _sig(idx)
    except OSError: pass

_USO = {"t": 0, "bytes": 0}

def uso_gravacoes(forcar=False):
    """Tamanho de ui/rec — percorrer milhares de arquivos a cada 8s pesa no HD; recalcula a cada 60s."""
    if forcar or time.time() - _USO["t"] > 60:
        _USO["bytes"] = dir_size_bytes(REC); _USO["t"] = time.time()
    return _USO["bytes"]

def dir_size_bytes(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try: total += os.path.getsize(os.path.join(root, f))
            except OSError: pass
    return total

def all_segments():
    # lista (cam, fname, path, epoch) de todos os .mp4
    segs = []
    for cam in cams():
        d = os.path.join(REC, cam)
        if not os.path.isdir(d): continue
        for f in os.listdir(d):
            if f.endswith(".mp4"):
                e = seg_epoch(f)
                if e: segs.append((cam, f, os.path.join(d, f), e))
    return segs

def _so_gravacao(path):
    """Trava de segurança: a limpeza só pode apagar arquivos dentro de ui/rec/<câmera>/.
    Fotos da IA (dados/ia), clipes, ocorrências e planilhas NUNCA são apagados aqui."""
    rp, base = os.path.realpath(path), os.path.realpath(REC) + os.sep
    if not rp.startswith(base) or os.sep + "dados" + os.sep in rp:
        raise RuntimeError(f"recusado: {path} está fora das gravações")
    return path

def _apagar(path):
    os.remove(_so_gravacao(path))

_MAN = {}
_PROT = {}     # dia -> (quando buscou, [horários protegidos], vendas_ok)

def horarios_protegidos(day):
    """Horários em que NÃO se apaga gravação por falta de movimento: vendas (market4u, via painel),
    ocorrências marcadas e movimentações detectadas nas prateleiras."""
    c = _PROT.get(day)
    if c and time.time() - c[0] < 300:
        return c[1], c[2]
    hs, ok = [], False
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{PAINEL_PORTA}/api/vendas/horarios?dia={day}", timeout=60) as r:
            hs += json.load(r).get("horarios", [])
            ok = True
    except Exception:
        pass
    dados = os.path.join(HERE, "dados")
    try:
        for o in json.load(open(os.path.join(dados, "ocorrencias.json"), encoding="utf-8")):
            if day_of(o["t"]) == day: hs.append(o["t"])
    except Exception:
        pass
    try:
        for e in json.load(open(os.path.join(dados, "prateleiras", "eventos", f"{day}.json"), encoding="utf-8")):
            hs.append(e["inicio"])
    except Exception:
        pass
    hs = sorted(hs)
    _PROT[day] = (time.time(), hs, ok)
    return hs, ok

def _protegido(hs, t0, t1):
    """o trecho [t0,t1] cai na janela de algum horário protegido?"""
    import bisect
    i = bisect.bisect_left(hs, t0 - PROTEGE_DEPOIS_S)
    return i < len(hs) and hs[i] <= t1 + PROTEGE_ANTES_S

def tick():
    os.makedirs(REC, exist_ok=True)
    camlist = cams()
    now = time.time()
    # mapa de índices por (cam, day)
    indices = {}

    # 1) pontuar segmentos novos (menos o mais recente de cada câmera = ainda gravando)
    for cam in camlist:
        d = os.path.join(REC, cam)
        if not os.path.isdir(d): continue
        files = sorted(f for f in os.listdir(d) if f.endswith(".mp4"))
        if not files: continue
        inprogress = files[-1]
        for f in files:
            e = seg_epoch(f)
            if not e: continue
            day = day_of(e)
            key = (cam, day)
            if key not in indices:
                indices[key] = load_index(cam, day)
                # descarta do índice o que foi apagado por fora (ex.: pela tela Disco do painel)
                present = set(files)
                for gone in [k for k in indices[key] if k not in present]:
                    indices[key].pop(gone, None)
            idx = indices[key]
            if f in idx:   # já pontuado
                continue
            if f == inprogress:   # ainda gravando, pontua na próxima volta
                continue
            path = os.path.join(d, f)
            idx[f] = {"t": round(e, 2), "d": probe_dur(path), "m": motion_score(path)}

    # 2) marcar "manter" por movimento + margem, por câmera/dia
    to_delete = []
    for (cam, day), idx in indices.items():
        items = sorted(idx.items(), key=lambda kv: kv[1]["t"])
        keep = [False] * len(items)
        for i, (f, meta) in enumerate(items):
            if meta["m"] >= MOTION_THRESHOLD:
                for j in range(max(0, i - KEEP_MARGIN_SEGS), min(len(items), i + KEEP_MARGIN_SEGS + 1)):
                    keep[j] = True
        hs = None
        for i, (f, meta) in enumerate(items):
            age = now - (meta["t"] + meta["d"])
            if age > RETENTION_HOURS * 3600:
                to_delete.append((cam, day, f)); continue
            if keep[i] or age <= GRACE_HOURS * 3600:
                continue
            # sem movimento e passou da folga: só apaga se não estiver perto de venda/ocorrência/prateleira
            if hs is None:
                hs, vendas_ok = horarios_protegidos(day)
            if not vendas_ok and age < 12 * 3600:
                break                         # sem saber das vendas: espera (até 12h) antes de podar
            if not _protegido(hs, meta["t"], meta["t"] + meta["d"]):
                to_delete.append((cam, day, f))

    for cam, day, f in to_delete:
        try: _apagar(os.path.join(REC, cam, f))
        except (OSError, RuntimeError): pass
        indices[(cam, day)].pop(f, None)

    # 3) teto de disco: se ui/rec > CAP ou disco livre < FLOOR, apaga os mais antigos (qualquer)
    try:
        du = shutil.disk_usage(REC)
        free_gb = du.free / 1e9
    except Exception:
        free_gb = 999
    used_gb = uso_gravacoes() / 1e9
    if used_gb > CAP_GB or free_gb < FREE_FLOOR_GB:
        used_gb = uso_gravacoes(forcar=True) / 1e9
        segs = sorted(all_segments(), key=lambda s: s[3])  # mais antigo primeiro
        i = 0
        while i < len(segs) and (used_gb > CAP_GB * 0.95 or free_gb < FREE_FLOOR_GB + 1):
            cam, f, path, e = segs[i]; i += 1
            try:
                sz = os.path.getsize(path); _apagar(path)
                used_gb -= sz / 1e9; free_gb += sz / 1e9; _USO["bytes"] -= sz
                day = day_of(e)
                if (cam, day) in indices: indices[(cam, day)].pop(f, None)
                else:
                    ix = load_index(cam, day); ix.pop(f, None); save_index(cam, day, ix)
            except (OSError, RuntimeError):
                pass

    # 4) salvar índices e manifest
    days = set()
    for (cam, day), idx in indices.items():
        save_index(cam, day, idx)
        if idx: days.add(day)
    # dias existentes (mesmo sem alteração nesta volta)
    for cam in camlist:
        d = os.path.join(REC, cam)
        if os.path.isdir(d):
            names = os.listdir(d)
            have_mp4 = {day_of(seg_epoch(f)) for f in names if f.endswith(".mp4") and seg_epoch(f)}
            for f in names:
                if f.endswith(".json"):
                    if f[:-5] in have_mp4:
                        days.add(f[:-5])
                    else:   # índice de um dia já sem vídeo (apagado): remove
                        try: _apagar(os.path.join(d, f))
                        except (OSError, RuntimeError): pass
    manifest = {
        "updated": round(now, 1),
        "cams": [{"id": c} for c in camlist],
        "days": sorted(days),
        "seg_seconds": SEG_SECONDS,
        "disk": {"used_gb": round(used_gb, 2), "cap_gb": CAP_GB, "free_gb": round(free_gb, 1)},
    }
    # manifest: só regrava se mudou (ou a cada minuto, para o "atualizado")
    sem_hora = json.dumps({k: v for k, v in manifest.items() if k != "updated"}, sort_keys=True)
    if sem_hora != _MAN.get("s") or now - _MAN.get("t", 0) > 60:
        tmp = os.path.join(REC, "manifest.json.tmp")
        with open(tmp, "w") as f: json.dump(manifest, f)
        os.replace(tmp, os.path.join(REC, "manifest.json"))
        _MAN.update(s=sem_hora, t=now)

def main():
    print(f"gravador: manutenção a cada {LOOP_SECONDS}s | rec={REC}")
    print(f"  movimento>={MOTION_THRESHOLD}  teto={CAP_GB}GB  piso_livre={FREE_FLOOR_GB}GB  retencao={RETENTION_HOURS}h")
    while True:
        try:
            tick()
        except Exception as e:
            print("erro no tick:", e)
        time.sleep(LOOP_SECONDS)

if __name__ == "__main__":
    main()
