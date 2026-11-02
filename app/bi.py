#!/usr/bin/env python3
# bi.py — Dashboard de vendas: junta as planilhas diárias do market4u (vendas, transações e
# produtos removidos, guardadas em dados/vendas/) e calcula os indicadores de um período,
# comparando com o período anterior de mesmo tamanho. Só lê arquivos; quem baixa é o market4u.py.
import os, re, time, threading
from datetime import date, datetime, timedelta
from collections import defaultdict

import market4u

DIAS_SEMANA = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]


def _ler(path, fn):
    try:
        return fn(open(path, "rb").read())
    except Exception:
        return None


def _dias(de, ate):
    d = de
    while d <= ate:
        yield d
        d += timedelta(days=1)


def pagamento_curto(p):
    """'POS Cartão de crédito (visa)' -> 'Crédito'; 'POS Pix (pix)' -> 'Pix'; 'APP crédito' -> 'App · crédito'."""
    s = (p or "").strip()
    if not s:
        return "—"
    app = s.upper().startswith("APP")
    s = re.sub(r"^(POS|APP)\s*", "", s, flags=re.I)
    s = re.sub(r"\(.*?\)", "", s).strip()
    low = s.lower()
    if "pix" in low:
        nome = "Pix"
    elif "débito" in low or "debito" in low:
        nome = "Débito"
    elif "crédito" in low or "credito" in low:
        nome = "Crédito"
    elif "carteira" in low or "saldo" in low:
        nome = "Carteira"
    elif "voucher" in low or "vale" in low:
        nome = "Voucher/VR"
    else:
        nome = s[:1].upper() + s[1:] if s else "Outro"
    return ("App · " + nome.lower()) if app else nome


def carregar(m4u, de, ate):
    """Lê as planilhas guardadas. dias_det = dias que já têm transações (clientes/pagamento) baixadas."""
    itens, trans, rem, dias_ok, dias_sem, dias_det = [], {}, {}, [], [], []
    for d in _dias(de, ate):
        it = _ler(m4u._arq(d), market4u.ler_planilha)
        if it is None:
            dias_sem.append(d.isoformat())
            continue
        alvo = d.isoformat()
        itens += [i for i in it if i["datahora"].startswith(alvo)]
        dias_ok.append(alvo)
        tx = _ler(m4u._arq(d, "_transacoes"), market4u.ler_transacoes)
        if tx is not None:
            dias_det.append(alvo)
            trans.update(tx)
        for k, v in (_ler(m4u._arq(d, "_removidos"), market4u.ler_removidos) or {}).items():
            rem.setdefault(k, []).extend(v)
    return itens, trans, rem, dias_ok, dias_sem, dias_det


def _faixa(idade):
    try:
        i = int(float(idade))
    except (TypeError, ValueError):
        return None
    if i <= 0 or i > 110:
        return None
    for lim, nome in ((17, "até 17"), (24, "18–24"), (34, "25–34"), (44, "35–44"), (54, "45–54"), (64, "55–64")):
        if i <= lim:
            return nome
    return "65+"


def indicadores(itens, trans, rem, de, ate, com_tx=True):
    n_dias = (ate - de).days + 1
    fat = sum(i["valor"] for i in itens)
    custo = sum(i["custo"] for i in itens)
    compras = {i["transacao"] for i in itens if i["transacao"]}
    tx_ef = {k: t for k, t in trans.items() if t["tipo"].lower().startswith("compra efetuada")}
    tx_removida = [t for t in trans.values() if t["tipo"].lower().startswith("compra removida")]
    ident = [t for t in tx_ef.values() if t["identificado"]]
    n_rem = sum(len(v) for v in rem.values())
    k = {
        "faturamento": round(fat, 2), "custo": round(custo, 2), "margem": round(fat - custo, 2),
        "margem_pct": round((fat - custo) / fat * 100, 1) if fat else None,
        "compras": len(compras), "itens": round(sum(i["qtd"] for i in itens), 1),
        "ticket_medio": round(fat / len(compras), 2) if compras else None,
        "itens_por_compra": round(sum(i["qtd"] for i in itens) / len(compras), 2) if compras else None,
        "fat_por_dia": round(fat / n_dias, 2) if n_dias else None,
        "pct_identificadas": round(len(ident) / len(tx_ef) * 100, 1) if tx_ef else None,
        "clientes_identificados": len({t["cliente_id"] for t in ident}),
        "compras_removidas": len(tx_removida),
        "taxa_desistencia": round(len(tx_removida) / (len(compras) + len(tx_removida)) * 100, 1) if (compras or tx_removida) else None,
        "produtos_removidos": n_rem,
    }
    if not com_tx:      # sem as transações de todos os dias, esses números enganam na comparação
        for c in ("pct_identificadas", "clientes_identificados", "compras_removidas", "taxa_desistencia", "produtos_removidos"):
            k[c] = None
    return k


def calcular(m4u, de, ate):
    n = (ate - de).days + 1
    pde, pate = de - timedelta(days=n), de - timedelta(days=1)
    itens, trans, rem, dias_ok, dias_sem, dias_det = carregar(m4u, de, ate)
    p_itens, p_trans, p_rem, p_ok, _, p_det = carregar(m4u, pde, pate)

    out = {"de": de.isoformat(), "ate": ate.isoformat(), "anterior": {"de": pde.isoformat(), "ate": pate.isoformat()},
           "dias": n, "dias_com_dados": len(dias_ok), "dias_sem_dados": dias_sem, "gerado_em": time.time(),
           "dias_com_detalhes": len(dias_det), "dias_anterior_com_detalhes": len(p_det)}
    out["kpi"] = indicadores(itens, trans, rem, de, ate, com_tx=bool(dias_det))
    out["kpi_anterior"] = indicadores(p_itens, p_trans, p_rem, pde, pate, com_tx=len(p_det) >= len(p_ok) > 0) if p_ok else None

    # --- por dia (atual e anterior, alinhados pela posição) ---
    def por_dia(its, a, b):
        m = {d.isoformat(): {"fat": 0.0, "margem": 0.0, "tx": set()} for d in _dias(a, b)}
        for i in its:
            x = m.get(i["datahora"][:10])
            if x is None:
                continue
            x["fat"] += i["valor"]
            x["margem"] += i["valor"] - i["custo"]
            if i["transacao"]:
                x["tx"].add(i["transacao"])
        return [{"dia": k, "faturamento": round(v["fat"], 2), "margem": round(v["margem"], 2), "compras": len(v["tx"])}
                for k, v in m.items()]
    out["por_dia"] = por_dia(itens, de, ate)
    out["por_dia_anterior"] = por_dia(p_itens, pde, pate) if p_ok else None

    # --- dia da semana x hora (compras e faturamento) ---
    hm = [[{"fat": 0.0, "tx": set()} for _ in range(24)] for _ in range(7)]
    for i in itens:
        if not i.get("t"):
            continue
        dt = datetime.fromtimestamp(i["t"])
        c = hm[dt.weekday()][dt.hour]
        c["fat"] += i["valor"]
        if i["transacao"]:
            c["tx"].add(i["transacao"])
    # quantas vezes cada dia da semana aparece no período (para média por dia)
    ocorr = [0] * 7
    for d in _dias(de, ate):
        ocorr[d.weekday()] += 1
    out["heatmap"] = {"dias": DIAS_SEMANA, "ocorrencias": ocorr,
                      "compras": [[len(c["tx"]) for c in row] for row in hm],
                      "faturamento": [[round(c["fat"], 2) for c in row] for row in hm]}

    # --- categorias, produtos, fabricantes ---
    def agrupar(its, chave):
        g = defaultdict(lambda: {"fat": 0.0, "custo": 0.0, "qtd": 0.0, "tx": set()})
        for i in its:
            x = g[chave(i)]
            x["fat"] += i["valor"]; x["custo"] += i["custo"]; x["qtd"] += i["qtd"]
            if i["transacao"]:
                x["tx"].add(i["transacao"])
        return g
    cat, pcat = agrupar(itens, lambda i: i["categoria"] or "Sem categoria"), agrupar(p_itens, lambda i: i["categoria"] or "Sem categoria")
    out["categorias"] = sorted([{"nome": k, "faturamento": round(v["fat"], 2), "margem": round(v["fat"] - v["custo"], 2),
                                 "margem_pct": round((v["fat"] - v["custo"]) / v["fat"] * 100, 1) if v["fat"] else None,
                                 "qtd": round(v["qtd"], 1), "compras": len(v["tx"]),
                                 "anterior": round(pcat[k]["fat"], 2) if k in pcat else 0}
                                for k, v in cat.items()], key=lambda x: -x["faturamento"])

    chave_prod = lambda i: (i["codigo"] or i["produto"])
    prod, pprod = agrupar(itens, chave_prod), agrupar(p_itens, chave_prod)
    info = {}
    for i in itens:
        info.setdefault(chave_prod(i), (i["produto"], i["categoria"], i["fabricante"]))
    # removidos por produto (código)
    rem_prod = defaultdict(lambda: {"n": 0, "nome": "", "cat": ""})
    for lst in rem.values():
        for r in lst:
            x = rem_prod[r["codigo"] or r["produto"]]
            x["n"] += 1; x["nome"] = r["produto"]; x["cat"] = r["categoria"]
    prods = []
    for k, v in prod.items():
        nome, catg, fab = info[k]
        prods.append({"codigo": k, "nome": nome, "categoria": catg, "fabricante": fab,
                      "faturamento": round(v["fat"], 2), "margem": round(v["fat"] - v["custo"], 2),
                      "margem_pct": round((v["fat"] - v["custo"]) / v["fat"] * 100, 1) if v["fat"] else None,
                      "qtd": round(v["qtd"], 1), "compras": len(v["tx"]),
                      "preco_medio": round(v["fat"] / v["qtd"], 2) if v["qtd"] else None,
                      "anterior": round(pprod[k]["fat"], 2) if k in pprod else 0,
                      "anterior_qtd": round(pprod[k]["qtd"], 1) if k in pprod else 0,
                      "removidos": rem_prod[k]["n"] if k in rem_prod else 0})
    prods.sort(key=lambda x: -x["faturamento"])
    # curva ABC (80% / 95% do faturamento)
    total = sum(p["faturamento"] for p in prods) or 1
    acum = 0
    for p in prods:
        acum += p["faturamento"]
        p["abc"] = "A" if acum / total <= 0.80 or acum == p["faturamento"] else ("B" if acum / total <= 0.95 else "C")
    out["produtos"] = prods
    out["abc"] = {c: {"produtos": sum(1 for p in prods if p["abc"] == c),
                      "faturamento": round(sum(p["faturamento"] for p in prods if p["abc"] == c), 2)} for c in "ABC"}
    # produtos que venderam no período anterior e não venderam agora
    out["sumiram"] = sorted([{"codigo": k, "nome": next((i["produto"] for i in p_itens if chave_prod(i) == k), k),
                              "anterior": round(v["fat"], 2), "anterior_qtd": round(v["qtd"], 1)}
                             for k, v in pprod.items() if k not in prod and v["fat"] > 0],
                            key=lambda x: -x["anterior"])[:15]

    fab = agrupar(itens, lambda i: i["fabricante"] or "—")
    out["fabricantes"] = sorted([{"nome": k, "faturamento": round(v["fat"], 2), "qtd": round(v["qtd"], 1)}
                                 for k, v in fab.items()], key=lambda x: -x["faturamento"])[:15]

    # --- removidos do carrinho ---
    vend_qtd = {p["codigo"]: p["qtd"] for p in prods}
    out["removidos"] = sorted([{"codigo": k, "nome": v["nome"], "categoria": v["cat"], "removidos": v["n"],
                                "vendidos": vend_qtd.get(k, 0),
                                "taxa": round(v["n"] / (v["n"] + vend_qtd.get(k, 0)) * 100) if (v["n"] + vend_qtd.get(k, 0)) else None}
                               for k, v in rem_prod.items()], key=lambda x: -x["removidos"])[:20]

    # --- pagamentos e canal ---
    pg = defaultdict(lambda: {"n": 0, "total": 0.0})
    via = defaultdict(lambda: {"n": 0, "total": 0.0})
    fat_tx = defaultdict(float)
    for i in itens:
        fat_tx[i["transacao"]] += i["valor"]
    for tid, t in trans.items():
        if not t["tipo"].lower().startswith("compra efetuada"):
            continue
        v = fat_tx.get(tid) or t["total"]
        x = pg[pagamento_curto(t["pagamento"])]; x["n"] += 1; x["total"] += v
        y = via[t["via"] or "—"]; y["n"] += 1; y["total"] += v
    out["pagamentos"] = sorted([{"nome": k, "compras": v["n"], "total": round(v["total"], 2)} for k, v in pg.items()],
                               key=lambda x: -x["total"])
    out["canais"] = sorted([{"nome": k, "compras": v["n"], "total": round(v["total"], 2)} for k, v in via.items()],
                           key=lambda x: -x["total"])

    # --- clientes identificados (CPF na nota) ---
    cli = defaultdict(lambda: {"nome": "", "compras": 0, "gasto": 0.0, "ultima": "", "total_vida": ""})
    for tid, t in trans.items():
        if not (t["identificado"] and t["tipo"].lower().startswith("compra efetuada")):
            continue
        c = cli[t["cliente_id"]]
        c["nome"] = t["nome"]; c["compras"] += 1; c["gasto"] += fat_tx.get(tid) or t["total"]
        c["ultima"] = max(c["ultima"], t["datahora"]); c["total_vida"] = t["compras_cliente"]
    out["clientes"] = sorted([{"id": k, "nome": v["nome"], "compras": v["compras"], "gasto": round(v["gasto"], 2),
                               "ultima": v["ultima"], "compras_total": v["total_vida"]}
                              for k, v in cli.items()], key=lambda x: -x["gasto"])[:20]
    p_cli = {t["cliente_id"] for t in p_trans.values() if t["identificado"] and t["tipo"].lower().startswith("compra efetuada")}
    out["clientes_resumo"] = {"ativos": len(cli), "voltaram": len(set(cli) & p_cli), "novos_no_periodo": len(set(cli) - p_cli),
                              "nao_voltaram": len(p_cli - set(cli))}

    # --- perfil (só quem tem cadastro com idade/sexo) ---
    perfil_tx = {}
    for i in itens:
        if i["transacao"] and i["transacao"] not in perfil_tx and (i.get("sexo") or i.get("idade")):
            t = trans.get(i["transacao"])
            if t and not t["identificado"]:
                continue
            perfil_tx[i["transacao"]] = (i.get("sexo") or "", _faixa(i.get("idade")))
    sexo, faixa = defaultdict(lambda: [0, 0.0]), defaultdict(lambda: [0, 0.0])
    for tid, (s, f) in perfil_tx.items():
        v = fat_tx.get(tid, 0)
        if s and s.lower() not in ("0", "não informado", "nao informado"):
            sexo[s][0] += 1; sexo[s][1] += v
        if f:
            faixa[f][0] += 1; faixa[f][1] += v
    ordem = ["até 17", "18–24", "25–34", "35–44", "45–54", "55–64", "65+"]
    out["perfil"] = {"sexo": [{"nome": k, "compras": v[0], "ticket": round(v[1] / v[0], 2) if v[0] else None}
                              for k, v in sorted(sexo.items(), key=lambda x: -x[1][0])],
                     "faixa": [{"nome": k, "compras": faixa[k][0], "ticket": round(faixa[k][1] / faixa[k][0], 2) if faixa[k][0] else None}
                               for k in ordem if k in faixa]}

    extras(out, itens, trans, rem, p_itens, p_trans, de, ate, pde, pate, fat_tx, prods, m4u)
    out["insights"] = insights(out)
    return out


def _bucket(v, limites, nomes):
    for lim, nome in zip(limites, nomes):
        if v <= lim:
            return nome
    return nomes[-1]


def extras(out, itens, trans, rem, p_itens, p_trans, de, ate, pde, pate, fat_tx, prods, m4u):
    """Análises a mais do Dashboard completo."""
    hoje = date.today()
    # --- acumulado do período x anterior ---
    def acum(pd):
        a, r = 0.0, []
        for d in pd or []:
            a += d["faturamento"]
            r.append(round(a, 2))
        return r
    out["acumulado"] = acum(out["por_dia"])
    out["acumulado_anterior"] = acum(out["por_dia_anterior"]) if out["por_dia_anterior"] else None

    # --- semanas e meses ---
    def agrupa_tempo(chave):
        g = defaultdict(lambda: {"fat": 0.0, "custo": 0.0, "tx": set(), "dias": set()})
        for i in itens:
            d = datetime.strptime(i["datahora"][:10], "%Y-%m-%d").date()
            x = g[chave(d)]
            x["fat"] += i["valor"]; x["custo"] += i["custo"]; x["dias"].add(d)
            if i["transacao"]:
                x["tx"].add(i["transacao"])
        return [{"periodo": k, "faturamento": round(v["fat"], 2), "margem": round(v["fat"] - v["custo"], 2),
                 "compras": len(v["tx"]), "dias": len(v["dias"]),
                 "ticket": round(v["fat"] / len(v["tx"]), 2) if v["tx"] else None,
                 "media_dia": round(v["fat"] / len(v["dias"]), 2) if v["dias"] else None}
                for k, v in sorted(g.items())]
    out["por_semana"] = agrupa_tempo(lambda d: (d - timedelta(days=d.weekday())).isoformat())
    out["por_mes"] = agrupa_tempo(lambda d: d.strftime("%Y-%m"))

    # --- projeção do mês corrente (usa as planilhas guardadas do mês e do mês anterior) ---
    ini_mes = hoje.replace(day=1)
    fim_ant = ini_mes - timedelta(days=1)
    ini_ant = fim_ant.replace(day=1)
    import calendar
    dias_mes = calendar.monthrange(hoje.year, hoje.month)[1]
    def soma(a, b):
        tot, ok = 0.0, 0
        for d in _dias(a, b):
            it = _ler(m4u._arq(d), market4u.ler_planilha)
            if it is None:
                continue
            ok += 1
            tot += sum(i["valor"] for i in it if i["datahora"].startswith(d.isoformat()))
        return tot, ok
    mtd, ok_mtd = soma(ini_mes, hoje)
    ant, ok_ant = soma(ini_ant, fim_ant)
    agora = datetime.now()
    decorrido = (hoje.day - 1) + (agora.hour * 60 + agora.minute) / 1440
    ant_ate_hoje, _ = soma(ini_ant, min(fim_ant, ini_ant + timedelta(days=hoje.day - 1)))
    out["projecao_mes"] = {
        "mes": hoje.strftime("%Y-%m"), "ate_agora": round(mtd, 2), "dias_mes": dias_mes, "dia": hoje.day,
        "completo": ok_mtd == hoje.day,
        "projecao": round(mtd / decorrido * dias_mes, 2) if decorrido >= 1 else None,
        "mes_anterior": round(ant, 2) if ok_ant == fim_ant.day else None,
        "mes_anterior_mesmo_dia": round(ant_ate_hoje, 2) if ok_ant else None,
    }

    # --- tamanho das compras ---
    itens_tx = defaultdict(float)
    for i in itens:
        if i["transacao"]:
            itens_tx[i["transacao"]] += i["qtd"]
    tick = [v for k, v in fat_tx.items() if k]
    nomes_t = ["até R$5", "R$5–10", "R$10–20", "R$20–30", "R$30–50", "R$50–100", "R$100+"]
    dist = defaultdict(lambda: {"n": 0, "fat": 0.0})
    for v in tick:
        b = _bucket(v, [5, 10, 20, 30, 50, 100, 1e12], nomes_t)
        dist[b]["n"] += 1; dist[b]["fat"] += v
    out["ticket_dist"] = [{"nome": n, "compras": dist[n]["n"], "faturamento": round(dist[n]["fat"], 2)} for n in nomes_t]
    nomes_i = ["1 item", "2 itens", "3 itens", "4 itens", "5–7", "8+"]
    di = defaultdict(int)
    for v in itens_tx.values():
        di[_bucket(v, [1, 2, 3, 4, 7, 1e9], nomes_i)] += 1
    out["itens_dist"] = [{"nome": n, "compras": di[n]} for n in nomes_i]

    # --- cesta: produtos comprados juntos ---
    por_tx = defaultdict(set)
    nome_de = {}
    for i in itens:
        if i["transacao"]:
            k = i["codigo"] or i["produto"]
            por_tx[i["transacao"]].add(k)
            nome_de[k] = i["produto"]
    n_tx = len(por_tx) or 1
    cont = defaultdict(int)
    par = defaultdict(int)
    for ks in por_tx.values():
        for k in ks:
            cont[k] += 1
        ks = sorted(ks)
        if len(ks) > 12:
            continue
        for a_ in range(len(ks)):
            for b_ in range(a_ + 1, len(ks)):
                par[(ks[a_], ks[b_])] += 1
    cesta = []
    for (a_, b_), c in par.items():
        if c < 3:
            continue
        lift = c / n_tx / ((cont[a_] / n_tx) * (cont[b_] / n_tx))
        cesta.append({"a": nome_de[a_], "b": nome_de[b_], "juntos": c,
                      "pct_a": round(c / cont[a_] * 100), "pct_b": round(c / cont[b_] * 100), "lift": round(lift, 1)})
    cesta.sort(key=lambda x: (-x["juntos"], -x["lift"]))
    out["cesta"] = cesta[:20]
    out["compras_multiplas_pct"] = round(sum(1 for ks in por_tx.values() if len(ks) > 1) / n_tx * 100, 1) if por_tx else None

    # --- produtos: altas, quedas, novos, preços ---
    com_ant = [p for p in prods if p["anterior"] > 0]
    out["altas"] = sorted([dict(p, delta=round(p["faturamento"] - p["anterior"], 2)) for p in com_ant if p["faturamento"] > p["anterior"]],
                          key=lambda x: -x["delta"])[:10]
    quedas = []
    for p in com_ant:
        if p["faturamento"] < p["anterior"]:
            quedas.append(dict(p, delta=round(p["faturamento"] - p["anterior"], 2)))
    for s_ in out["sumiram"]:
        quedas.append({"codigo": s_["codigo"], "nome": s_["nome"], "faturamento": 0, "anterior": s_["anterior"], "delta": -s_["anterior"], "qtd": 0})
    out["quedas"] = sorted(quedas, key=lambda x: x["delta"])[:10]
    out["novos"] = [p for p in prods if not p["anterior"]][:15]
    pq = defaultdict(lambda: [0.0, 0.0])
    for i in p_itens:
        x = pq[i["codigo"] or i["produto"]]
        x[0] += i["valor"]; x[1] += i["qtd"]
    precos = []
    for p in prods:
        a_ = pq.get(p["codigo"])
        if a_ and a_[1] >= 1 and p["qtd"] >= 1 and p["preco_medio"]:
            pa = a_[0] / a_[1]
            v = (p["preco_medio"] - pa) / pa * 100
            if abs(v) >= 3:
                precos.append({"nome": p["nome"], "antes": round(pa, 2), "agora": p["preco_medio"], "var": round(v, 1),
                               "qtd": p["qtd"], "qtd_antes": round(a_[1], 1)})
    out["precos"] = sorted(precos, key=lambda x: -abs(x["var"]))[:15]

    # --- clientes: recência, frequência, em risco, identificado x não ---
    todas = list(p_trans.values()) + list(trans.values())
    hist = defaultdict(lambda: {"nome": "", "compras": 0, "gasto": 0.0, "ultima": "", "primeira": "9999"})
    fat_tx_ant = defaultdict(float)
    for i in p_itens:
        fat_tx_ant[i["transacao"]] += i["valor"]
    for t in todas:
        if not (t["identificado"] and t["tipo"].lower().startswith("compra efetuada")):
            continue
        h = hist[t["cliente_id"]]
        h["nome"] = t["nome"]; h["compras"] += 1
        h["gasto"] += fat_tx.get(t["id"]) or fat_tx_ant.get(t["id"]) or t["total"]
        h["ultima"] = max(h["ultima"], t["datahora"]); h["primeira"] = min(h["primeira"], t["datahora"])
    ref = datetime.combine(min(ate, hoje), datetime.max.time())
    rec = defaultdict(int)
    nomes_r = ["até 7 dias", "8–14 dias", "15–30 dias", "mais de 30 dias"]
    risco = []
    for cid, h in hist.items():
        try:
            dias = (ref - datetime.strptime(h["ultima"][:19], "%Y-%m-%d %H:%M:%S")).days
        except ValueError:
            continue
        rec[_bucket(dias, [7, 14, 30, 1e9], nomes_r)] += 1
        if h["compras"] >= 3 and dias >= 10:
            risco.append({"id": cid, "nome": h["nome"], "compras": h["compras"], "gasto": round(h["gasto"], 2),
                          "ultima": h["ultima"], "dias": dias})
    out["clientes_recencia"] = [{"nome": n, "clientes": rec[n]} for n in nomes_r]
    out["clientes_risco"] = sorted(risco, key=lambda x: -x["gasto"])[:15]
    freq = defaultdict(int)
    nomes_f = ["1 compra", "2–3", "4–7", "8–15", "16+"]
    cli_per = defaultdict(int)
    for t in trans.values():
        if t["identificado"] and t["tipo"].lower().startswith("compra efetuada"):
            cli_per[t["cliente_id"]] += 1
    for v in cli_per.values():
        freq[_bucket(v, [1, 3, 7, 15, 1e9], nomes_f)] += 1
    out["clientes_frequencia"] = [{"nome": n, "clientes": freq[n]} for n in nomes_f]
    idv = {"ident": [0, 0.0, 0.0], "nao": [0, 0.0, 0.0]}
    for tid, t in trans.items():
        if not t["tipo"].lower().startswith("compra efetuada") or tid not in fat_tx:
            continue
        x = idv["ident" if t["identificado"] else "nao"]
        x[0] += 1; x[1] += fat_tx[tid]; x[2] += itens_tx.get(tid, 0)
    out["ident_vs_nao"] = {k: {"compras": v[0], "faturamento": round(v[1], 2),
                               "ticket": round(v[1] / v[0], 2) if v[0] else None,
                               "itens": round(v[2] / v[0], 2) if v[0] else None} for k, v in idv.items()}

    # --- operação: desistências por dia, removidos por categoria e por hora, financeiro ---
    des = defaultdict(int)
    for t in trans.values():
        if t["tipo"].lower().startswith("compra removida"):
            des[t["datahora"][:10]] += 1
    out["desistencias_dia"] = [{"dia": d["dia"], "n": des.get(d["dia"], 0), "compras": d["compras"]} for d in out["por_dia"]]
    rc, rh = defaultdict(int), [0] * 24
    for lst in rem.values():
        for r in lst:
            rc[r["categoria"] or "—"] += 1
            if r.get("t"):
                rh[datetime.fromtimestamp(r["t"]).hour] += 1
    cat_qtd = {c["nome"]: c["qtd"] for c in out["categorias"]}
    out["removidos_categoria"] = sorted([{"nome": k, "removidos": v, "vendidos": cat_qtd.get(k, 0)} for k, v in rc.items()],
                                        key=lambda x: -x["removidos"])[:10]
    out["removidos_hora"] = rh
    fin = {"desconto": 0.0, "estorno": 0.0, "voucher": 0.0, "cashback": 0.0, "n_desconto": 0, "n_estorno": 0, "n_voucher": 0, "n_cashback": 0}
    status = defaultdict(int)
    for t in trans.values():
        status[t["tipo"] or "—"] += 1
        for c in ("desconto", "estorno", "voucher", "cashback"):
            v = t.get(c) or 0
            if v:
                fin[c] += v; fin["n_" + c] += 1
    out["financeiro"] = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in fin.items()}
    out["tipos_transacao"] = sorted([{"nome": k, "n": v} for k, v in status.items()], key=lambda x: -x["n"])

    # --- destaques ---
    pd_ = [d for d in out["por_dia"] if d["compras"]]
    if pd_:
        out["melhor_dia"] = max(pd_, key=lambda d: d["faturamento"])
        out["pior_dia"] = min([d for d in pd_ if d["dia"] != hoje.isoformat()] or pd_, key=lambda d: d["faturamento"])
    out["skus"] = len(prods)
    # ticket médio por hora (média do período)
    hh = defaultdict(lambda: [0.0, set()])
    for i in itens:
        if i.get("t") and i["transacao"]:
            h = datetime.fromtimestamp(i["t"]).hour
            hh[h][0] += i["valor"]; hh[h][1].add(i["transacao"])
    out["ticket_hora"] = [round(hh[h][0] / len(hh[h][1]), 2) if hh[h][1] else None for h in range(24)]


def _brl(v):
    return ("R$ " + f"{v:,.2f}").replace(",", "X").replace(".", ",").replace("X", ".")


def insights(o):
    """Frases curtas com o que mais chama atenção no período."""
    ins = []
    k, ka = o["kpi"], o.get("kpi_anterior")
    if ka and ka["faturamento"]:
        var = (k["faturamento"] - ka["faturamento"]) / ka["faturamento"] * 100
        if abs(var) >= 3:
            ins.append({"tipo": "bom" if var > 0 else "ruim",
                        "txt": f"Faturamento {'subiu' if var > 0 else 'caiu'} {abs(var):.0f}% em relação aos {o['dias']} dias anteriores "
                               f"({_brl(ka['faturamento'])} → {_brl(k['faturamento'])})."})
        if ka.get("ticket_medio") and k.get("ticket_medio"):
            vt = (k["ticket_medio"] - ka["ticket_medio"]) / ka["ticket_medio"] * 100
            if abs(vt) >= 5:
                ins.append({"tipo": "bom" if vt > 0 else "ruim",
                            "txt": f"Ticket médio {'subiu' if vt > 0 else 'caiu'} {abs(vt):.0f}% ({_brl(ka['ticket_medio'])} → {_brl(k['ticket_medio'])})."})
    hm = o["heatmap"]
    # melhor dia da semana (média por ocorrência)
    medias = [(sum(hm["faturamento"][d]) / hm["ocorrencias"][d], d) for d in range(7) if hm["ocorrencias"][d]]
    if medias and len(medias) >= 3:
        best, worst = max(medias), min(medias)
        if best[0] > 0:
            nomes = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
            ins.append({"tipo": "info", "txt": f"Melhor dia da semana: {nomes[best[1]]} (média {_brl(best[0])}); o mais fraco é {nomes[worst[1]]} ({_brl(worst[0])})."})
    horas = [sum(hm["compras"][d][h] for d in range(7)) for h in range(24)]
    if sum(horas):
        # janela de 3 horas com mais compras
        j = max(range(22), key=lambda h: horas[h] + horas[h + 1] + horas[h + 2])
        pct = (horas[j] + horas[j + 1] + horas[j + 2]) / sum(horas) * 100
        ins.append({"tipo": "info", "txt": f"Horário de pico: {j}h–{j + 3}h concentra {pct:.0f}% das compras. Bom momento para a loja estar abastecida."})
        mad = sum(horas[0:6])
        if mad / sum(horas) >= 0.08:
            ins.append({"tipo": "info", "txt": f"{mad / sum(horas) * 100:.0f}% das compras são de madrugada (0h–6h)."})
    cats = [c for c in o["categorias"] if c["anterior"] > 50]
    if cats and ka:
        cres = max(cats, key=lambda c: (c["faturamento"] - c["anterior"]) / c["anterior"])
        qued = min(cats, key=lambda c: (c["faturamento"] - c["anterior"]) / c["anterior"])
        vc = (cres["faturamento"] - cres["anterior"]) / cres["anterior"] * 100
        vq = (qued["faturamento"] - qued["anterior"]) / qued["anterior"] * 100
        if vc >= 10:
            ins.append({"tipo": "bom", "txt": f"Categoria que mais cresceu: {cres['nome'].title()} (+{vc:.0f}%)."})
        if vq <= -10:
            ins.append({"tipo": "ruim", "txt": f"Categoria que mais caiu: {qued['nome'].title()} ({vq:.0f}%)."})
    a = o["abc"]["A"]
    if a["produtos"] and o["produtos"]:
        ins.append({"tipo": "info", "txt": f"{a['produtos']} produtos ({a['produtos'] / len(o['produtos']) * 100:.0f}% do mix vendido) fazem 80% do faturamento — são os que não podem faltar."})
    baixa = [p for p in o["produtos"][:40] if p["margem_pct"] is not None and p["margem_pct"] < 15 and p["faturamento"] > 30]
    if baixa:
        ins.append({"tipo": "ruim", "txt": "Vendem bem mas com margem baixa (<15%): " + ", ".join(f"{p['nome']} ({p['margem_pct']:.0f}%)" for p in baixa[:3]) + "."})
    rm = [r for r in o["removidos"] if r["removidos"] >= 3 and r["taxa"] and r["taxa"] >= 30]
    if rm:
        r = rm[0]
        ins.append({"tipo": "ruim", "txt": f"{r['nome']} é tirado do carrinho com frequência ({r['removidos']}× removido, {r['taxa']}% das vezes que foi pego). Pode ser preço."})
    if k.get("taxa_desistencia") and k["taxa_desistencia"] >= 5 and k.get("compras_removidas"):
        ins.append({"tipo": "ruim", "txt": f"{k['compras_removidas']} compras desistidas ({k['taxa_desistencia']:.0f}% das tentativas)."})
    cr = o["clientes_resumo"]
    if cr["nao_voltaram"] >= 3 and o["dias_anterior_com_detalhes"] and o["dias_com_detalhes"] >= o["dias_com_dados"]:
        ins.append({"tipo": "info", "txt": f"{cr['nao_voltaram']} clientes identificados compraram no período anterior e não voltaram neste."})
    if o["sumiram"]:
        s = o["sumiram"][:3]
        ins.append({"tipo": "info", "txt": "Venderam no período anterior e nada agora (falta na prateleira?): " + ", ".join(x["nome"] for x in s) + "."})
    pm = o.get("projecao_mes") or {}
    if pm.get("projecao") and pm.get("mes_anterior"):
        v = (pm["projecao"] - pm["mes_anterior"]) / pm["mes_anterior"] * 100
        ins.append({"tipo": "bom" if v >= 0 else "ruim",
                    "txt": f"No ritmo atual o mês fecha em {_brl(pm['projecao'])} ({'+' if v >= 0 else ''}{v:.0f}% sobre o mês passado, {_brl(pm['mes_anterior'])})."})
    if o.get("cesta"):
        c = o["cesta"][0]
        ins.append({"tipo": "info", "txt": f"Combinação mais comum: {c['a']} + {c['b']} ({c['juntos']} compras juntos). Vale deixar perto na prateleira."})
    if o.get("precos"):
        p = o["precos"][0]
        ins.append({"tipo": "info", "txt": f"Preço de {p['nome']} mudou {p['var']:+.0f}% ({_brl(p['antes'])} → {_brl(p['agora'])}); vendeu {p['qtd_antes']:.0f} → {p['qtd']:.0f} un."})
    iv = o.get("ident_vs_nao") or {}
    if iv.get("ident", {}).get("ticket") and iv.get("nao", {}).get("ticket") and iv["ident"]["compras"] >= 10:
        r = (iv["ident"]["ticket"] - iv["nao"]["ticket"]) / iv["nao"]["ticket"] * 100
        if abs(r) >= 10:
            ins.append({"tipo": "info", "txt": f"Quem põe CPF na nota gasta {abs(r):.0f}% {'mais' if r > 0 else 'menos'} por compra ({_brl(iv['ident']['ticket'])} x {_brl(iv['nao']['ticket'])})."})
    if o.get("clientes_risco"):
        ins.append({"tipo": "ruim", "txt": f"{len(o['clientes_risco'])} cliente(s) frequentes não compram há 10+ dias (ex.: {o['clientes_risco'][0]['nome']}, {o['clientes_risco'][0]['dias']} dias)."})
    return ins


class BaixaDetalhes:
    """Baixa em segundo plano as transações e os removidos de cada dia (o market4u leva ~10-15 s por dia
    nesse relatório). Um dia de cada vez, do mais recente para o mais antigo; o que já veio fica guardado."""

    def __init__(self, m4u):
        self.m4u = m4u
        self.fila = []
        self.lock = threading.Lock()
        self.th = None
        self.atual = None
        self.feitos = 0
        self.erro = None
        self.falhou = {}          # dia -> horário da falha (não tenta de novo por 10 min)

    def pedir(self, dias):
        """dias: em ordem de prioridade. Substitui a fila (o último pedido do Dashboard manda)."""
        agora = time.time()
        novos = [d for d in dias if not self.m4u.detalhes_ok(d) and agora - self.falhou.get(d, 0) > 600]
        with self.lock:
            if not self.fila and not self.atual:
                self.feitos = 0
            self.fila = [d for d in novos if d != self.atual]
            if self.fila and (self.th is None or not self.th.is_alive()):
                self.erro = None
                self.th = threading.Thread(target=self._rodar, daemon=True)
                self.th.start()

    def _rodar(self):
        while True:
            with self.lock:
                if not self.fila:
                    self.atual = None
                    return
                d = self.fila.pop(0)
                self.atual = d
            try:
                if not self.m4u.detalhes_ok(d):
                    self.m4u.baixar_detalhes(d)
                with self.lock:
                    self.feitos += 1
            except market4u.PrecisaLogin as e:
                with self.lock:
                    self.erro, self.fila, self.atual = str(e), [], None
                return
            except Exception as e:
                with self.lock:
                    self.erro = f"{d.strftime('%d/%m')}: {e}"
                    self.falhou[d] = time.time()
            time.sleep(1)

    def status(self):
        with self.lock:
            return {"pendentes": len(self.fila) + (1 if self.atual else 0), "feitos": self.feitos,
                    "baixando": self.atual.isoformat() if self.atual else None, "erro": self.erro}
