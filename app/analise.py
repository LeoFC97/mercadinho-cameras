#!/usr/bin/env python3
# analise.py — cruza o movimento gravado com as vendas do market4u.
# Um "evento" é um trecho com movimento (em qualquer câmera), juntando pedaços próximos.
# Evento sem nenhuma venda perto (antes/depois) = suspeito: alguém esteve na loja e não pagou nada.
import os, json
from datetime import date

MOTION_TH = float(os.environ.get("MOTION_EVENT_TH", "1.6"))    # mesmo limiar das marcas azuis da Revisão
JUNTA_S = float(os.environ.get("EVENTO_JUNTA_S", "60"))        # pedaços com até 60s entre si = mesmo evento
JANELA_VENDA_S = float(os.environ.get("EVENTO_JANELA_VENDA_S", "180"))  # venda até 3 min antes/depois conta


def carregar_indices(rec_dir, cams, dia: str):
    """{cam: [ {f,t,d,m}, ... ]} do dia (ordenado)."""
    out = {}
    for c in cams:
        p = os.path.join(rec_dir, c, f"{dia}.json")
        try:
            raw = json.load(open(p, encoding="utf-8"))
        except Exception:
            raw = {}
        out[c] = sorted(({"f": f, **v} for f, v in raw.items()), key=lambda s: s["t"])
    return out


def eventos(indices, vendas_ts, th=MOTION_TH, junta=JUNTA_S, janela=JANELA_VENDA_S):
    pedacos = []
    for cam, segs in indices.items():
        for s in segs:
            if s.get("m", 0) >= th:
                pedacos.append((s["t"], s["t"] + s.get("d", 12), cam, s.get("m", 0)))
    pedacos.sort()
    evs = []
    for ini, fim, cam, m in pedacos:
        if evs and ini <= evs[-1]["fim"] + junta:
            e = evs[-1]
            e["fim"] = max(e["fim"], fim)
            e["cams"].add(cam)
            e["pico"] = max(e["pico"], m)
        else:
            evs.append({"inicio": ini, "fim": fim, "cams": {cam}, "pico": m})
    vendas_ts = sorted(t for t in vendas_ts if t)
    for e in evs:
        perto = [t for t in vendas_ts if e["inicio"] - janela <= t <= e["fim"] + janela]
        e["vendas"] = len(perto)
        e["cams"] = sorted(e["cams"])
        e["inicio"] = round(e["inicio"], 1)
        e["fim"] = round(e["fim"], 1)
        e["pico"] = round(e["pico"], 2)
        e["duracao"] = round(e["fim"] - e["inicio"], 1)
    return evs


def analise_dia(rec_dir, cams, dia: date, m4u=None):
    """Eventos do dia + horários de venda. m4u: cliente market4u (opcional)."""
    ds = dia.strftime("%Y-%m-%d")
    idx = carregar_indices(rec_dir, cams, ds)
    vendas, vendas_ok, erro, velha = [], False, "", False
    if m4u is not None:
        try:
            r = m4u.vendas_cache(dia)
            grupos = {}
            for i in r["itens"]:
                if not i.get("t"):
                    continue
                k = i.get("transacao") or i["datahora"]
                g = grupos.setdefault(k, {"t": i["t"], "total": 0.0, "itens": 0, "produtos": []})
                g["total"] = round(g["total"] + i["valor"], 2)
                g["itens"] += i["qtd"]
                if len(g["produtos"]) < 4:
                    g["produtos"].append(i["produto"])
            vendas = sorted(grupos.values(), key=lambda g: g["t"])
            vendas_ok, velha = True, bool(r.get("velha"))
        except Exception as e:
            erro = str(e)
    evs = eventos(idx, [v["t"] for v in vendas])
    if not vendas_ok:
        for e in evs:
            e["vendas"] = None          # sem dados de venda: não dá para classificar
    return {"dia": ds, "limiar": MOTION_TH, "janela_venda_s": JANELA_VENDA_S,
            "vendas_ok": vendas_ok, "vendas_velhas": velha, "vendas_erro": erro,
            "vendas": vendas, "eventos": evs,
            "sem_venda": sum(1 for e in evs if e["vendas"] == 0)}
