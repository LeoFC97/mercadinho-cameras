#!/usr/bin/env python3
# ia.py — base de imagens para treinar a rede neural que vai reconhecer os produtos.
#
#   dados/ia/classes.json        produtos que a IA vai aprender (nome, código de barras, categoria)
#   dados/ia/imagens/<id>.jpg    fotos (das câmeras ao vivo em HD, ou tiradas das gravações)
#   dados/ia/imagens/<id>_m.jpg  miniatura (para a galeria)
#   dados/ia/rotulos/<id>.json   marcações: caixas (x,y,w,h de 0 a 1) com o produto de cada uma
#   dados/ia/export/             pacote no formato YOLO (Ultralytics) para treinar na RTX
#
# Sem bibliotecas extras: o ffmpeg tira as fotos e o próprio Python lê o tamanho do JPEG.
#
# REGRA: nada aqui é apagado pela limpeza de espaço (gravador.py e a tela Disco só mexem em ui/rec/).
# Até o botão "Apagar foto" só move para dados/ia/lixeira.
import os, re, io, json, time, glob, shutil, struct, zipfile, hashlib, secrets, threading, subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

IS_WIN = os.name == "nt"
ID_RE = re.compile(r"^[\w-]{1,80}$")
STATUS = ("pendente", "rotulada", "fundo")


def _ffmpeg(here):
    f = os.environ.get("FFMPEG")
    if f and (os.path.isfile(f) or shutil.which(f)):
        return f
    local = os.path.join(here, "bin", "ffmpeg.exe" if IS_WIN else "ffmpeg")
    if os.path.isfile(local):
        return local
    return "/opt/homebrew/bin/ffmpeg" if os.path.isfile("/opt/homebrew/bin/ffmpeg") else "ffmpeg"


def _run(args, timeout):
    kw = {"creationflags": 0x08000000} if IS_WIN else {}
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, **kw)


def jpeg_tamanho(path):
    """(largura, altura) lendo o cabeçalho do JPEG."""
    with open(path, "rb") as f:
        if f.read(2) != b"\xff\xd8":
            return None
        while True:
            b = f.read(1)
            while b and b != b"\xff":
                b = f.read(1)
            while b == b"\xff":
                b = f.read(1)
            if not b:
                return None
            m = b[0]
            if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                continue
            seg = f.read(2)
            if len(seg) < 2:
                return None
            n = struct.unpack(">H", seg)[0]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                d = f.read(5)
                h, w = struct.unpack(">HH", d[1:5])
                return w, h
            f.seek(n - 2, 1)


def _txt(v, n):
    return str(v or "").strip()[:n]


class IA:
    def __init__(self, here, rec_dir, dados_dir, cams_fn, rtsp_base=None):
        self.here, self.rec, self.cams_fn = here, rec_dir, cams_fn
        self.rtsp = rtsp_base or os.environ.get("IA_RTSP_BASE", "rtsp://127.0.0.1:8554")   # restream do go2rtc
        self.dir = os.path.join(dados_dir, "ia")
        self.vendas_dir = os.path.join(dados_dir, "vendas")
        self.img = os.path.join(self.dir, "imagens")
        self.rot = os.path.join(self.dir, "rotulos")
        self.exp = os.path.join(self.dir, "export")
        for d in (self.img, self.rot, self.exp):
            os.makedirs(d, exist_ok=True)
        self.lock = threading.RLock()
        self.cls_path = os.path.join(self.dir, "classes.json")

    # ---------- produtos (classes) ----------
    def classes(self):
        try:
            return json.load(open(self.cls_path, encoding="utf-8"))
        except Exception:
            return []

    def _gravar_classes(self, lst):
        tmp = self.cls_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lst, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.cls_path)

    def criar_classe(self, d):
        nome = _txt(d.get("nome"), 120)
        if not nome:
            raise ValueError("informe o nome do produto")
        with self.lock:
            lst = self.classes()
            if any(c["nome"].lower() == nome.lower() for c in lst):
                raise ValueError("já existe um produto com esse nome")
            c = {"id": max([c["id"] for c in lst] + [-1]) + 1, "nome": nome,
                 "barras": _txt(d.get("barras"), 40), "categoria": _txt(d.get("categoria"), 80),
                 "autor": _txt(d.get("autor"), 60), "criado_em": time.time()}
            lst.append(c)
            self._gravar_classes(lst)
            return c

    def editar_classe(self, cid, d):
        with self.lock:
            lst = self.classes()
            for c in lst:
                if c["id"] == cid:
                    if "nome" in d:
                        n = _txt(d["nome"], 120)
                        if not n:
                            raise ValueError("nome vazio")
                        if any(x["nome"].lower() == n.lower() and x["id"] != cid for x in lst):
                            raise ValueError("já existe um produto com esse nome")
                        c["nome"] = n
                    for k, n in (("barras", 40), ("categoria", 80)):
                        if k in d:
                            c[k] = _txt(d[k], n)
                    self._gravar_classes(lst)
                    return c
        raise KeyError("produto não encontrado")

    def apagar_classe(self, cid):
        with self.lock:
            usos = sum(1 for r in self._rotulos() for b in r.get("caixas", []) if b["classe"] == cid)
            if usos:
                raise ValueError(f"esse produto está marcado em {usos} caixa(s); tire as marcações antes de apagar")
            lst = [c for c in self.classes() if c["id"] != cid]
            self._gravar_classes(lst)

    def sugestoes(self, limite=80):
        """Produtos que aparecem nas planilhas de venda já baixadas (os mais vendidos primeiro)."""
        import market4u
        cont = {}
        for p in sorted(glob.glob(os.path.join(self.vendas_dir, "*.csv")))[-45:]:
            try:
                for i in market4u.ler_planilha(open(p, "rb").read()):
                    k = i["produto"]
                    if not k:
                        continue
                    c = cont.setdefault(k, {"nome": k, "barras": i["barras"], "categoria": i["categoria"], "vendas": 0})
                    c["vendas"] += i["qtd"]
            except Exception:
                continue
        ja = {c["nome"].lower() for c in self.classes()}
        out = [c for c in cont.values() if c["nome"].lower() not in ja]
        out.sort(key=lambda c: -c["vendas"])
        return out[:limite]

    # ---------- imagens ----------
    def _rot_path(self, iid):
        return os.path.join(self.rot, iid + ".json")

    def _rotulos(self):
        out = []
        for p in glob.glob(os.path.join(self.rot, "*.json")):
            try:
                out.append(json.load(open(p, encoding="utf-8")))
            except Exception:
                pass
        return out

    def obter(self, iid):
        if not ID_RE.match(iid or ""):
            return None
        try:
            return json.load(open(self._rot_path(iid), encoding="utf-8"))
        except Exception:
            return None

    def _salvar(self, r):
        tmp = self._rot_path(r["id"]) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False)
        os.replace(tmp, self._rot_path(r["id"]))

    def caminho_img(self, nome):
        """nome = '<id>.jpg' ou '<id>_m.jpg'"""
        m = re.match(r"^([\w-]{1,80}?)(_m)?\.jpg$", nome or "")
        if not m:
            return None
        p = os.path.join(self.img, nome)
        return p if os.path.isfile(p) else None

    def _registrar(self, jpg, origem, cam, t, autor, extra=None):
        iid = os.path.basename(jpg)[:-4]
        tam = jpeg_tamanho(jpg) or (0, 0)
        # miniatura
        try:
            _run([_ffmpeg(self.here), "-nostdin", "-v", "error", "-y", "-i", jpg, "-vf", "scale=320:-2", "-q:v", "5",
                  os.path.join(self.img, iid + "_m.jpg")], 30)
        except Exception:
            pass
        r = {"id": iid, "w": tam[0], "h": tam[1], "origem": origem, "cam": cam, "t": t,
             "autor": _txt(autor, 60), "criado_em": time.time(), "status": "pendente", "caixas": [],
             "rotulado_por": None, "rotulado_em": None}
        if extra:
            r.update(extra)
        self._salvar(r)
        return r

    def _novo_id(self, cam, t):
        return time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + f"-{cam}-" + secrets.token_hex(2)

    def capturar_ao_vivo(self, cams, qtd=1, intervalo=1.0, autor=""):
        """Fotos em HD do stream principal (via go2rtc). qtd fotos por câmera, com intervalo em segundos."""
        qtd = max(1, min(int(qtd or 1), 20))
        intervalo = max(0.3, min(float(intervalo or 1), 10.0))
        cams = [c for c in (cams or []) if c in self.cams_fn()]
        if not cams:
            raise ValueError("escolha pelo menos uma câmera")
        t0 = time.time()

        def uma(cam):
            base = self._novo_id(cam, t0)
            padrao = os.path.join(self.img, base + "-%02d.jpg")
            args = [_ffmpeg(self.here), "-nostdin", "-v", "error", "-y"]
            if self.rtsp.startswith("rtsp"):
                args += ["-rtsp_transport", "tcp"]
            args += ["-i", f"{self.rtsp}/{cam}", "-an"]
            if qtd > 1:
                args += ["-vf", f"fps=1/{intervalo}"]
            args += ["-frames:v", str(qtd), "-q:v", "2", padrao]
            try:
                p = _run(args, 25 + qtd * intervalo)
                erro = p.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] if p.returncode else []
            except subprocess.TimeoutExpired:
                erro = ["tempo esgotado"]
            fotos = sorted(glob.glob(os.path.join(self.img, base + "-[0-9][0-9].jpg")))
            out = []
            for k, f in enumerate(fotos):
                out.append(self._registrar(f, "ao_vivo", cam, round(t0 + k * (intervalo if qtd > 1 else 0), 1), autor))
            return out, (f"{cam}: {erro[0]}" if erro and not fotos else None)

        with ThreadPoolExecutor(max_workers=len(cams)) as ex:
            res = list(ex.map(uma, cams))
        imgs = [r for lst, _ in res for r in lst]
        erros = [e for _, e in res if e]
        if not imgs:
            raise ValueError("não consegui tirar as fotos: " + ("; ".join(erros) or "câmeras sem imagem"))
        return {"imagens": imgs, "erros": erros}

    def previa(self, cam):
        """Quadro atual (pequeno) da câmera, para a tela de captura. Guarda por 3s para não sobrecarregar."""
        if cam not in self.cams_fn():
            raise KeyError("câmera não encontrada")
        if not hasattr(self, "_prev"):
            self._prev, self._prev_lock = {}, {}
        lk = self._prev_lock.setdefault(cam, threading.Lock())
        with lk:
            t, data = self._prev.get(cam, (0, None))
            if data and time.time() - t < 3:
                return data
            src = f"{self.rtsp}/{cam}_sub" if self.rtsp.startswith("rtsp") else f"{self.rtsp}/{cam}"
            args = [_ffmpeg(self.here), "-nostdin", "-v", "error"]
            if self.rtsp.startswith("rtsp"):
                args += ["-rtsp_transport", "tcp"]
            args += ["-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "6", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]
            try:
                p = _run(args, 12)
            except subprocess.TimeoutExpired:
                raise ValueError("câmera sem imagem")
            if p.returncode or not p.stdout:
                raise ValueError("câmera sem imagem")
            self._prev[cam] = (time.time(), p.stdout)
            return p.stdout

    def _seg_em(self, cam, t):
        dia = datetime.fromtimestamp(t).strftime("%Y-%m-%d")
        try:
            raw = json.load(open(os.path.join(self.rec, cam, f"{dia}.json"), encoding="utf-8"))
        except Exception:
            return None
        best = None
        for f, v in raw.items():
            if v["t"] <= t < v["t"] + v.get("d", 12) + 0.25 and (best is None or v["t"] > best[1]["t"]):
                best = (f, v)
        if not best:
            return None
        path = os.path.join(self.rec, cam, best[0])
        return (path, max(0.0, t - best[1]["t"])) if os.path.isfile(path) else None

    def capturar_gravacao(self, cams, tempos, autor="", venda=None):
        """Fotos tiradas das gravações nos horários pedidos (ex.: perto de uma venda)."""
        cams = [c for c in (cams or []) if c in self.cams_fn()]
        if not cams:
            raise ValueError("escolha pelo menos uma câmera")
        tempos = [float(t) for t in (tempos or [])][:12]
        if not tempos:
            raise ValueError("horário inválido")
        trabalhos = [(c, t) for t in tempos for c in cams]

        def uma(ct):
            cam, t = ct
            s = self._seg_em(cam, t)
            if not s:
                return None
            path, off = s
            out = os.path.join(self.img, self._novo_id(cam, t) + ".jpg")
            try:
                _run([_ffmpeg(self.here), "-nostdin", "-v", "error", "-y", "-ss", f"{off:.3f}", "-i", path,
                      "-frames:v", "1", "-q:v", "2", out], 30)
            except subprocess.TimeoutExpired:
                return None
            if not os.path.isfile(out):
                return None
            extra = {"venda": venda} if isinstance(venda, dict) else None
            return self._registrar(out, "venda" if venda else "gravacao", cam, round(t, 1), autor, extra)

        with ThreadPoolExecutor(max_workers=4) as ex:
            imgs = [r for r in ex.map(uma, trabalhos) if r]
        if not imgs:
            raise ValueError("não há gravação nesse horário (pode já ter sido apagada pela limpeza)")
        return {"imagens": imgs, "erros": []}

    def listar(self, status="pendente", classe=None, limite=300):
        lst = self._rotulos()
        if status and status != "todas":
            lst = [r for r in lst if r.get("status") == status]
        if classe is not None:
            lst = [r for r in lst if any(b["classe"] == classe for b in r.get("caixas", []))]
        lst.sort(key=lambda r: r.get("criado_em", 0), reverse=(status != "pendente"))
        return lst[:limite], len(lst)

    def rotular(self, iid, d):
        autor = _txt(d.get("autor"), 60)
        if not autor:
            raise ValueError("informe o seu nome")
        ids = {c["id"] for c in self.classes()}
        caixas = []
        for b in d.get("caixas") or []:
            try:
                x, y, w, h = (min(1.0, max(0.0, float(b[k]))) for k in ("x", "y", "w", "h"))
                cl = int(b["classe"])
            except (KeyError, TypeError, ValueError):
                raise ValueError("caixa inválida")
            if cl not in ids:
                raise ValueError("produto inexistente numa das caixas")
            w, h = min(w, 1 - x), min(h, 1 - y)
            if w > 0.003 and h > 0.003:
                caixas.append({"classe": cl, "x": round(x, 5), "y": round(y, 5), "w": round(w, 5), "h": round(h, 5)})
        status = d.get("status") or ("rotulada" if caixas else "fundo")
        if status not in STATUS:
            raise ValueError("status inválido")
        if status == "rotulada" and not caixas:
            raise ValueError("marque pelo menos um produto (ou use 'sem produto')")
        with self.lock:
            r = self.obter(iid)
            if not r:
                raise KeyError("imagem não encontrada")
            r.update(caixas=caixas if status != "fundo" else [], status=status, rotulado_por=autor, rotulado_em=time.time())
            self._salvar(r)
            return r

    def apagar(self, iid):
        """Tira a foto da base, mas NÃO apaga: move para dados/ia/lixeira (dá para recuperar copiando de volta)."""
        r = self.obter(iid)
        if not r:
            raise KeyError("imagem não encontrada")
        lix = os.path.join(self.dir, "lixeira")
        os.makedirs(lix, exist_ok=True)
        for p in (os.path.join(self.img, iid + ".jpg"), os.path.join(self.img, iid + "_m.jpg"), self._rot_path(iid)):
            if os.path.isfile(p):
                try:
                    shutil.move(p, os.path.join(lix, os.path.basename(p)))
                except OSError:
                    pass

    def resumo(self):
        rots = self._rotulos()
        cont = {}
        imgs_cl = {}
        for r in rots:
            if r.get("status") != "rotulada":
                continue
            vistos = set()
            for b in r.get("caixas", []):
                cont[b["classe"]] = cont.get(b["classe"], 0) + 1
                vistos.add(b["classe"])
            for c in vistos:
                imgs_cl[c] = imgs_cl.get(c, 0) + 1
        classes = [dict(c, caixas=cont.get(c["id"], 0), imagens=imgs_cl.get(c["id"], 0)) for c in self.classes()]
        tam = sum(os.path.getsize(os.path.join(r_, f)) for r_, _, fs in os.walk(self.dir) for f in fs)
        lixeira = len(glob.glob(os.path.join(self.dir, "lixeira", "*.json")))
        por = lambda s: sum(1 for r in rots if r.get("status") == s)
        exp = os.path.join(self.exp, "dataset_yolo.zip")
        return {"classes": classes, "total": len(rots), "pendentes": por("pendente"), "rotuladas": por("rotulada"),
                "fundo": por("fundo"), "caixas": sum(cont.values()), "disco_mb": round(tam / 1e6, 1), "lixeira": lixeira,
                "pasta": self.dir,
                "export": {"tamanho": os.path.getsize(exp), "em": os.path.getmtime(exp)} if os.path.isfile(exp) else None}

    # ---------- pacote para treino (YOLO / Ultralytics) ----------
    def exportar(self):
        with self.lock:
            classes = sorted(self.classes(), key=lambda c: c["id"])
            rots = [r for r in self._rotulos() if r.get("status") in ("rotulada", "fundo")]
            usados = sorted({b["classe"] for r in rots for b in r.get("caixas", [])})
            mapa = {cid: i for i, cid in enumerate(usados)}          # índices contínuos 0..N-1
            nomes = {c["id"]: c for c in classes}
            if not usados:
                raise ValueError("ainda não há imagens com produtos marcados")
            final = os.path.join(self.exp, "dataset_yolo.zip")
            tmp = final + ".tmp"
            n = {"train": 0, "val": 0}
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                for r in rots:
                    jpg = os.path.join(self.img, r["id"] + ".jpg")
                    if not os.path.isfile(jpg):
                        continue
                    # divisão fixa por imagem: ~20% validação
                    parte = "val" if int(hashlib.md5(r["id"].encode()).hexdigest(), 16) % 5 == 0 else "train"
                    n[parte] += 1
                    z.write(jpg, f"images/{parte}/{r['id']}.jpg", compress_type=zipfile.ZIP_STORED)
                    linhas = [f"{mapa[b['classe']]} {b['x'] + b['w'] / 2:.6f} {b['y'] + b['h'] / 2:.6f} {b['w']:.6f} {b['h']:.6f}"
                              for b in r.get("caixas", []) if b["classe"] in mapa]
                    z.writestr(f"labels/{parte}/{r['id']}.txt", "\n".join(linhas) + ("\n" if linhas else ""))
                yaml = ["# Produtos do mercadinho — gerado pelo painel das câmeras",
                        f"# {time.strftime('%Y-%m-%d %H:%M')} — {n['train']} imagens de treino, {n['val']} de validação",
                        "# (sem 'path': o Ultralytics usa a pasta deste arquivo)",
                        "train: images/train", "val: images/val", "names:"]
                yaml += [f"  {i}: {json.dumps(nomes[cid]['nome'], ensure_ascii=False)}" for cid, i in mapa.items()]
                z.writestr("data.yaml", "\n".join(yaml) + "\n")
                csvl = ["indice;id;nome;codigo_de_barras;categoria"]
                csvl += [f"{i};{cid};{nomes[cid]['nome']};{nomes[cid].get('barras', '')};{nomes[cid].get('categoria', '')}"
                         for cid, i in mapa.items()]
                z.writestr("produtos.csv", "\n".join(csvl) + "\n")
                z.writestr("COMO_TREINAR.txt", COMO_TREINAR)
            os.replace(tmp, final)
            return {"arquivo": final, "tamanho": os.path.getsize(final), "imagens": n["train"] + n["val"],
                    "treino": n["train"], "validacao": n["val"], "produtos": len(usados)}


COMO_TREINAR = """Como treinar a IA dos produtos no PC com a RTX
================================================

1) Instale o Python 3.11 ou 3.12 e, no terminal:
     pip install ultralytics
   (a placa de vídeo NVIDIA precisa do driver atualizado; o Ultralytics instala o PyTorch com CUDA)

2) Descompacte este arquivo numa pasta, por exemplo C:\\ia\\dataset, e entre nela:
     cd C:\\ia\\dataset

3) Treine (começa de um modelo já treinado em objetos comuns, então precisa de menos fotos):
     yolo detect train data=data.yaml model=yolo11s.pt epochs=100 imgsz=960 batch=8

   Com uma RTX série 30 leva de minutos a algumas horas, conforme o número de fotos.
   O resultado fica em runs\\detect\\train\\weights\\best.pt

4) Teste numa foto ou vídeo:
     yolo detect predict model=runs\\detect\\train\\weights\\best.pt source=alguma_foto.jpg

Dicas
- Mire em pelo menos 100 a 150 marcações por produto, de câmeras e ângulos diferentes,
  com a mão segurando, dentro da geladeira, na prateleira etc.
- Inclua fotos "sem produto" (loja vazia, pessoas sem produto): elas ensinam o que NÃO é produto.
- O arquivo produtos.csv liga cada índice ao código de barras do market4u.
"""
