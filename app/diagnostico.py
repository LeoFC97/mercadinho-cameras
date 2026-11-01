#!/usr/bin/env python3
# diagnostico.py — por que a Revisão não está fluida? Mede a qualidade do que está GRAVADO
# (quadros por segundo de verdade, quadros perdidos no Wi-Fi da câmera, resolução, bitrate)
# e a carga do notebook. A parte da rede (velocidade até a loja) é medida pelo navegador.
import os, re, json, glob, shutil, subprocess, statistics, time

IS_WIN = os.name == "nt"


def _ffprobe(here):
    f = os.environ.get("FFPROBE")
    if f and (os.path.isfile(f) or shutil.which(f)):
        return f
    local = os.path.join(here, "bin", "ffprobe.exe" if IS_WIN else "ffprobe")
    if os.path.isfile(local):
        return local
    return "/opt/homebrew/bin/ffprobe" if os.path.isfile("/opt/homebrew/bin/ffprobe") else "ffprobe"


def _kw():
    return {"creationflags": 0x08000000} if IS_WIN else {}


def ler_env(here):
    env = {}
    try:
        for line in open(os.path.join(here, "gravador.env"), encoding="utf-8"):
            line = line.split("#", 1)[0].strip()
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


def definir_env(here, chave, valor):
    """Troca (ou acrescenta) uma linha CHAVE=valor no gravador.env, mantendo o resto."""
    p = os.path.join(here, "gravador.env")
    linhas, achou = [], False
    try:
        linhas = open(p, encoding="utf-8").read().splitlines()
    except OSError:
        pass
    for i, l in enumerate(linhas):
        if re.match(rf"^\s*{re.escape(chave)}\s*=", l):
            linhas[i] = f"{chave}={valor}"
            achou = True
    if not achou:
        linhas.append(f"{chave}={valor}")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\r\n" if IS_WIN else "\n") as f:
        f.write("\n".join(linhas) + "\n")
    os.replace(tmp, p)


def analisar_segmento(here, path):
    args = [_ffprobe(here), "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration,size",
            "-show_entries", "packet=pts_time,flags", "-of", "json", path]
    p = subprocess.run(args, capture_output=True, timeout=30, **_kw())
    j = json.loads(p.stdout.decode("utf-8", "replace") or "{}")
    st = (j.get("streams") or [{}])[0]
    fmt = j.get("format") or {}
    pts = sorted(float(k["pts_time"]) for k in j.get("packets", []) if k.get("pts_time") not in (None, "N/A"))
    keys = sum(1 for k in j.get("packets", []) if "K" in (k.get("flags") or ""))
    dur = float(fmt.get("duration") or 0) or ((pts[-1] - pts[0]) if len(pts) > 1 else 0)
    inter = [b - a for a, b in zip(pts, pts[1:]) if b > a]
    med = statistics.median(inter) if inter else 0
    buracos = [d for d in inter if med and d > med * 2.5]
    try:
        num, den = (st.get("avg_frame_rate") or "0/1").split("/")
        fps_decl = float(num) / float(den) if float(den) else 0
    except ValueError:
        fps_decl = 0
    return {"arquivo": os.path.basename(path), "codec": st.get("codec_name"), "w": st.get("width"), "h": st.get("height"),
            "duracao": round(dur, 2), "quadros": len(pts), "fps_real": round(len(pts) / dur, 1) if dur else 0,
            "fps_declarado": round(fps_decl, 1), "intervalo_mediano_ms": round(med * 1000),
            "buracos": len(buracos), "maior_buraco_s": round(max(buracos), 2) if buracos else 0,
            "kbps": round(int(fmt.get("size") or 0) * 8 / dur / 1000) if dur else 0,
            "keyframes": keys}


def cpu_percent():
    try:
        if IS_WIN:
            p = subprocess.run(["powershell", "-NoProfile", "-Command",
                                "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"],
                               capture_output=True, timeout=15, **_kw())
            return float(p.stdout.decode().strip().replace(",", "."))
        la = os.getloadavg()[0]
        return round(min(100.0, la / (os.cpu_count() or 1) * 100), 1)
    except Exception:
        return None


def processos_cpu():
    """Os programas que mais usam o processador agora (amostra de 2s)."""
    try:
        if IS_WIN:
            ps = ("$n=[Environment]::ProcessorCount;$a=@{};Get-Process|%{$a[$_.Id]=$_.CPU};Start-Sleep -Seconds 2;"
                  "Get-Process|%{ $c=$_.CPU; if($c -ne $null -and $a.ContainsKey($_.Id) -and $a[$_.Id] -ne $null){ "
                  "[pscustomobject]@{n=$_.ProcessName;c=[math]::Round(($c-$a[$_.Id])/2/$n*100,1);m=[math]::Round($_.WorkingSet64/1MB)} } }|"
                  "Group-Object n|%{[pscustomobject]@{n=$_.Name;c=($_.Group|Measure-Object c -Sum).Sum;m=($_.Group|Measure-Object m -Sum).Sum;q=$_.Count}}|"
                  "Sort-Object c -Descending|Select-Object -First 8|ConvertTo-Json -Compress")
            p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, timeout=25, **_kw())
            j = json.loads(p.stdout.decode("utf-8", "replace") or "[]")
            j = j if isinstance(j, list) else [j]
            return [{"nome": x["n"], "cpu": round(float(x["c"] or 0), 1), "mem_mb": int(x["m"] or 0), "qtd": int(x.get("q") or 1)} for x in j]
        p = subprocess.run(["ps", "-eo", "comm,%cpu,rss", "--sort=-%cpu"], capture_output=True, timeout=10)
        out = []
        for l in p.stdout.decode().splitlines()[1:9]:
            parts = l.split()
            if len(parts) >= 3:
                out.append({"nome": parts[0], "cpu": float(parts[1]), "mem_mb": int(parts[2]) // 1024, "qtd": 1})
        return out
    except Exception:
        return []


def diagnostico(here, rec_dir, cams):
    env = ler_env(here)
    out = {"rec_stream": env.get("REC_STREAM", os.environ.get("REC_STREAM", "sub")), "cameras": {}, "em": time.time()}
    for cam in cams:
        jsons = sorted(glob.glob(os.path.join(rec_dir, cam, "*.json")))
        segs = []
        for jp in reversed(jsons[-2:]):
            try:
                raw = json.load(open(jp, encoding="utf-8"))
            except Exception:
                continue
            segs += sorted(raw.items(), key=lambda kv: -kv[1]["t"])
            if len(segs) >= 3:
                break
        res = []
        for f, v in segs[:3]:
            p = os.path.join(rec_dir, cam, f)
            if os.path.isfile(p):
                try:
                    r = analisar_segmento(here, p)
                    r["t"] = v["t"]
                    r["url"] = f"/rec/{cam}/{f}"
                    res.append(r)
                except Exception as e:
                    res.append({"arquivo": f, "erro": str(e)[:200]})
        ok = [r for r in res if "erro" not in r]
        resumo = None
        if ok:
            resumo = {"w": ok[0]["w"], "h": ok[0]["h"], "codec": ok[0]["codec"],
                      "fps_real": round(sum(r["fps_real"] for r in ok) / len(ok), 1),
                      "fps_declarado": ok[0]["fps_declarado"],
                      "buracos_por_min": round(sum(r["buracos"] for r in ok) / max(1e-6, sum(r["duracao"] for r in ok)) * 60, 1),
                      "maior_buraco_s": max(r["maior_buraco_s"] for r in ok),
                      "kbps": round(sum(r["kbps"] for r in ok) / len(ok)),
                      "keyframe_s": round(sum(r["duracao"] for r in ok) / max(1, sum(r["keyframes"] for r in ok)), 1)}
        out["cameras"][cam] = {"segmentos": res, "resumo": resumo}
    out["cpu"] = cpu_percent()
    out["processos"] = processos_cpu()
    try:
        du = shutil.disk_usage(rec_dir)
        out["disco_livre_gb"] = round(du.free / 1e9, 1)
    except OSError:
        out["disco_livre_gb"] = None
    return out
