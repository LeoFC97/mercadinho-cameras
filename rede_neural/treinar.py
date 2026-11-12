#!/usr/bin/env python3
# Treino do detector de produtos a partir do pacote exportado na aba IA do painel (dataset_yolo.zip).
# Usa sempre os mesmos parâmetros e a mesma divisão treino/validação, para dar para comparar os treinos
# conforme entram mais fotos. Cada treino grava resultado.json e acrescenta uma linha em historico.csv.
#
# uso (Windows, PC com a RTX):
#   pip install ultralytics            (instale antes o PyTorch com CUDA: https://pytorch.org)
#   python treinar.py C:\ia\dataset  C:\ia\treinos\2026-11-04  [epocas=100] [max_fundo=150] [modelo=yolo11s.pt] [imgsz=960]
import sys, os, json, random, shutil, time
from pathlib import Path

ds, out = Path(sys.argv[1]), Path(sys.argv[2])
epocas = int(sys.argv[3]) if len(sys.argv) > 3 else 100
max_fundo = int(sys.argv[4]) if len(sys.argv) > 4 else 150
modelo = sys.argv[5] if len(sys.argv) > 5 else "yolo11s.pt"
imgsz = int(sys.argv[6]) if len(sys.argv) > 6 else 960
out.mkdir(parents=True, exist_ok=True)

# dataset reduzido: todas as fotos com produto + uma amostra das fotos de fundo (sem produto)
red = out / "dataset"
if red.exists():
    shutil.rmtree(red)
random.seed(0)
stats = {}
for parte in ("train", "val"):
    (red / "images" / parte).mkdir(parents=True)
    (red / "labels" / parte).mkdir(parents=True)
    com, fundo = [], []
    for lab in sorted((ds / "labels" / parte).glob("*.txt")):
        (com if lab.read_text().strip() else fundo).append(lab.stem)
    lim = max_fundo if parte == "train" else max_fundo // 3
    fundo = random.sample(fundo, min(lim, len(fundo)))
    for stem in com + fundo:
        shutil.copy(ds / "images" / parte / f"{stem}.jpg", red / "images" / parte / f"{stem}.jpg")
        shutil.copy(ds / "labels" / parte / f"{stem}.txt", red / "labels" / parte / f"{stem}.txt")
    stats[parte] = {"com_produto": len(com), "fundo": len(fundo)}
yaml = (ds / "data.yaml").read_text(encoding="utf-8").splitlines()
yaml = [l for l in yaml if not l.startswith(("train:", "val:", "path:"))]
(red / "data.yaml").write_text("\n".join([f"path: {red.resolve().as_posix()}", "train: images/train", "val: images/val"] + yaml) + "\n", encoding="utf-8")
print("dataset:", stats, flush=True)

import torch
from ultralytics import YOLO
dev = 0 if torch.cuda.is_available() else "cpu"
print("placa de vídeo:", torch.cuda.get_device_name(0) if dev == 0 else "NÃO ENCONTRADA (vai usar o processador, bem mais lento)", flush=True)
t0 = time.time()
m = YOLO(modelo)
m.train(data=str(red / "data.yaml"), epochs=epocas, imgsz=imgsz, batch=-1 if dev == 0 else 8, workers=4, device=dev,
        project=str(out), name="run", exist_ok=True, patience=0, plots=True, verbose=False,
        cache="ram", close_mosaic=5, seed=0)
dur = time.time() - t0
best = out / "run" / "weights" / "best.pt"
mv = YOLO(str(best)).val(data=str(red / "data.yaml"), imgsz=imgsz, batch=8, device=dev, split="val",
                          project=str(out), name="val", exist_ok=True, plots=True, verbose=False)
nomes = mv.names
por_classe = []
for i, c in enumerate(mv.box.ap_class_index):
    por_classe.append({"classe": nomes[int(c)], "ap50": round(float(mv.box.ap50[i]), 3), "ap50_95": round(float(mv.box.ap[i]), 3)})
res = {"quando": time.strftime("%Y-%m-%d %H:%M"), "modelo": modelo, "imgsz": imgsz, "epocas": epocas,
       "produtos": len(nomes), "minutos": round(dur / 60, 1), "dataset": stats,
       "map50": round(float(mv.box.map50), 3), "map50_95": round(float(mv.box.map), 3),
       "precisao": round(float(mv.box.mp), 3), "recall": round(float(mv.box.mr), 3), "por_classe": por_classe}
(out / "resultado.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
hist = out.parent / "historico.csv"
novo = not hist.exists()
with open(hist, "a", encoding="utf-8") as f:
    if novo:
        f.write("quando;pasta;modelo;imgsz;epocas;produtos;fotos_com_produto;fotos_fundo;mAP50;mAP50-95;precisao;recall;minutos\n")
    f.write(f"{res['quando']};{out.name};{modelo};{imgsz};{epocas};{len(nomes)};{stats['train']['com_produto'] + stats['val']['com_produto']};"
            f"{stats['train']['fundo'] + stats['val']['fundo']};{res['map50']};{res['map50_95']};{res['precisao']};{res['recall']};{res['minutos']}\n")
# previsões nas fotos de validação (para olhar)
pv = out / "previsoes"
pv.mkdir(exist_ok=True)
imgs = sorted((red / "images" / "val").glob("*.jpg"))
YOLO(str(best)).predict([str(p) for p in imgs], imgsz=imgsz, conf=0.25, device=dev, save=True,
                        project=str(out), name="previsoes", exist_ok=True, verbose=False)
print(f"\nPronto em {res['minutos']} min — mAP50 {res['map50']}, mAP50-95 {res['map50_95']}, precisão {res['precisao']}, recall {res['recall']}")
print(f"modelo: {best}\nfotos com as previsões: {pv}\nhistórico: {hist}", flush=True)
