#!/usr/bin/env python3
# estoque.py — Estoque do CD e da loja (market4u) + giro de vendas + lista de compras.
#
# De tempos em tempos (e quando pedem "Atualizar agora") baixa do market4u, só leitura:
#   - estoque do CD           /operacoes/cd/lstestoquenovo//ID/<CD>          (saldo, planograma, custo)
#   - estoque da loja (PDX)   /operacoes/maquina/lstestoquenovo//ID/<PDX>    (estoque, capacidade, última venda)
#   - movimentações do CD     /operacoes/cd/lstajusteestoquenovo//CD/<CD>    (entradas com o preço pago, saídas p/ loja)
# e cruza com as vendas (planilhas diárias já guardadas pelo painel) para saber quanto vende por dia,
# quantos dias o estoque dura e quanto comprar. Tudo fica em dados/estoque/ (fora do Git, nunca apagado).
import os, io, csv, json, math, time, base64, threading, urllib.parse
from datetime import date, datetime, timedelta
from collections import defaultdict

import market4u
from market4u import _limpa, _num

PADRAO = {"cd": "1529", "pdx": "20292", "intervalo_min": 30, "dias_cobertura": 14, "dias_giro": 30}


def _csv(raw: bytes):
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = [r for r in csv.reader(io.StringIO(txt), delimiter=";")]
    if not rows:
        return [], []
    head = [_limpa(h) for h in rows[0]]
    return head, [r for r in rows[1:] if any(x.strip() for x in r)]


def _cols(head, rows):
    """Linhas como dicionários. Colunas com nome repetido (ex.: 'PDX') ganham sufixo _2, _3..."""
    nomes, vistos = [], defaultdict(int)
    for h in head:
        vistos[h] += 1
        nomes.append(h if vistos[h] == 1 else f"{h}_{vistos[h]}")
    return [{n: _limpa(r[i]) if i < len(r) else "" for i, n in enumerate(nomes)} for r in rows]


def _data(v):
    try:
        return datetime.strptime(v[:19], "%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return None


class Estoque:
    def __init__(self, m4u, dados_dir):
        self.m4u = m4u
        self.dir = os.path.join(dados_dir, "estoque")
        os.makedirs(self.dir, exist_ok=True)
        self.lock = threading.Lock()
        self.estado = {"atualizando": False, "erro": None, "atualizado_em": None, "proxima": None}
        try:
            self.estado["atualizado_em"] = os.path.getmtime(self._p("cd.csv"))
        except OSError:
            pass
        self.cache = None
        self.th = None

    def _p(self, nome):
        return os.path.join(self.dir, nome)

    # --- configuração (intervalo, dias de cobertura, IDs do CD e da loja) ---
    def config(self):
        c = dict(PADRAO)
        try:
            c.update(json.load(open(self._p("config.json"), encoding="utf-8")))
        except Exception:
            pass
        return c

    def salvar_config(self, novo):
        c = self.config()
        for k in ("intervalo_min", "dias_cobertura", "dias_giro"):
            if k in novo:
                c[k] = max(1, min(1440 if k == "intervalo_min" else 180, int(novo[k])))
        for k in ("cd", "pdx"):
            if novo.get(k):
                c[k] = "".join(ch for ch in str(novo[k]) if ch.isdigit())[:12] or c[k]
        self._gravar_json("config.json", c)
        self.cache = None
        return c

    def _gravar_json(self, nome, obj):
        tmp = self._p(nome + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, self._p(nome))

    # --- download ---
    def _exportar(self, caminho, ref, dj=None, timeout=90):
        m = self.m4u
        post = {"BOX_LICENCIADO": "NaN", "type-post": "ajax", "full": "1", "lote": "1",
                "DATA_JSON": json.dumps(dj or {}), "limparsessao": "0", "version-system": "app"}
        q = urllib.parse.urlencode({"_action": "exportar", "POST": base64.b64encode(json.dumps(post).encode()).decode()})
        st, hd, raw, _ = m._req(caminho + "?" + q, referer=ref, timeout=timeout)
        if market4u.deslogado(raw):
            raise market4u.PrecisaLogin("o market4u encerrou a sessão do painel; conecte de novo em Vendas")
        if st in (401, 403):
            raise market4u.Market4uErro(f"o usuário do painel não tem permissão para ver {ref} no market4u")
        if st != 200:
            raise market4u.Market4uErro(f"o market4u respondeu HTTP {st} em {ref}")
        head, rows = _csv(raw)
        if not head or len(head) < 4:
            raise market4u.Market4uErro(f"o market4u não devolveu a planilha de {ref} (sem permissão?)")
        return raw

    def atualizar(self):
        """Baixa tudo de novo (uns poucos segundos). Uma atualização por vez."""
        if not self.lock.acquire(blocking=False):
            return False
        try:
            self.estado.update(atualizando=True, erro=None)
            c = self.config()
            m = self.m4u
            with m.lock:
                m._garantir_sessao()
            hoje = date.today()
            arquivos = {
                "cd.csv": (f"/operacoes/cd/lstestoquenovo//ID/{c['cd']}", f"/operacoes/form-cd/ID/{c['cd']}", None),
                "loja.csv": (f"/operacoes/maquina/lstestoquenovo//ID/{c['pdx']}", f"/operacoes/form-maquina/ID/{c['pdx']}", None),
                "movimentacoes.csv": (f"/operacoes/cd/lstajusteestoquenovo//CD/{c['cd']}", f"/operacoes/form-cd/ID/{c['cd']}",
                                      {"DATAHORA_DE": (hoje - timedelta(days=365)).strftime("%d/%m/%Y 00:00"),
                                       "DATAHORA_ATE": hoje.strftime("%d/%m/%Y 23:59")}),
            }
            for nome, (cam, ref, dj) in arquivos.items():
                raw = self._exportar(cam, ref, dj)
                with open(self._p(nome + ".tmp"), "wb") as f:
                    f.write(raw)
                os.replace(self._p(nome + ".tmp"), self._p(nome))
            # vendas dos últimos dias (giro) — planilhas diárias, rápido
            try:
                m.garantir_vendas(hoje - timedelta(days=max(30, c["dias_giro"]) - 1), hoje)
            except Exception as e:
                self.estado["erro"] = f"estoque atualizado, mas as vendas não vieram: {e}"
            m._salvar_cookies()
            self.estado["atualizado_em"] = time.time()
            self.cache = None
            return True
        except Exception as e:
            self.estado["erro"] = str(e)
            return False
        finally:
            self.estado["atualizando"] = False
            self.lock.release()

    def iniciar(self):
        """Atualiza sozinho a cada 'intervalo_min' (só se o market4u estiver conectado)."""
        if self.th:
            return
        def laco():
            time.sleep(20)
            while True:
                c = self.config()
                ult = self.estado.get("atualizado_em") or 0
                prox = ult + c["intervalo_min"] * 60
                self.estado["proxima"] = prox
                if time.time() >= prox and self.m4u._cfg().get("conectado"):
                    self.atualizar()
                time.sleep(30)
        self.th = threading.Thread(target=laco, daemon=True)
        self.th.start()

    # --- leitura e cálculo ---
    def _ler(self, nome):
        try:
            return _cols(*_csv(open(self._p(nome), "rb").read()))
        except OSError:
            return None

    def _vendas(self, dias):
        """unidades vendidas e faturamento por código nos últimos 'dias' (planilhas guardadas)."""
        hoje = date.today()
        out = defaultdict(lambda: {"qtd": 0.0, "fat": 0.0, "qtd7": 0.0, "ultima": ""})
        dias_ok = 0
        for i in range(dias):
            d = hoje - timedelta(days=i)
            try:
                it = market4u.ler_planilha(open(self.m4u._arq(d), "rb").read())
            except Exception:
                continue
            dias_ok += 1
            for x in it:
                if not x["datahora"].startswith(d.isoformat()):
                    continue
                for k in {x["codigo"], x["barras"]} - {""}:
                    v = out[k]
                    v["qtd"] += x["qtd"]; v["fat"] += x["valor"]
                    if i < 7:
                        v["qtd7"] += x["qtd"]
                    v["ultima"] = max(v["ultima"], x["datahora"])
        return out, dias_ok

    def dados(self):
        if self.cache and self.cache[0] == self.estado.get("atualizado_em"):
            out = dict(self.cache[1])
        else:
            out = self._calcular()
            self.cache = (self.estado.get("atualizado_em"), out)
            out = dict(out)
        c = self.config()
        out["estado"] = dict(self.estado, intervalo_min=c["intervalo_min"])
        out["config"] = c
        out["lista"] = self.lista()
        return out

    def _calcular(self):
        c = self.config()
        cd, loja, mov = self._ler("cd.csv"), self._ler("loja.csv"), self._ler("movimentacoes.csv")
        if cd is None:
            return {"produtos": [], "vazio": True}
        prods = {}
        def chave(r):
            return r.get("Código") or r.get("Código de Barras") or r.get("ID Produto") or r.get("ID")
        for r in cd:
            k = chave(r)
            if not k:
                continue
            prods[k] = {
                "codigo": r.get("Código", ""), "barras": r.get("Código de Barras", ""), "id": r.get("ID Produto", ""),
                "nome": r.get("Produto", ""), "categoria": r.get("Categoria", ""),
                "fornecedor": "" if r.get("Fornecedor") in ("--", None) else r.get("Fornecedor"),
                "descontinuado": (r.get("Descontinuado") or "").lower().startswith("s"),
                "cd": _num(r.get("Saldo - Estoque CD", "0")), "cd_reservado": _num(r.get("Reservado", "0")),
                "planograma": _num(r.get("Qtde - Planograma", "0")),
                "m4u_comprar": _num(r.get("Comprar", "0")),
                "custo": _num(r.get("Unitário - Custo", "0")),
                "loja": 0.0, "capacidade": 0.0, "ultima_venda_loja": "",
            }
        for r in loja or []:
            k = chave(r)
            if not k:
                continue
            p = prods.get(k)
            if p is None:
                p = prods[k] = {"codigo": r.get("Código", ""), "barras": r.get("Código de Barras", ""), "id": r.get("ID", "").lstrip("#"),
                                "nome": r.get("Produto", ""), "categoria": r.get("Categoria", ""), "fornecedor": "",
                                "descontinuado": (r.get("Desc. CD") or "").lower().startswith("s"),
                                "cd": _num(r.get("Estoque CD", "0")), "cd_reservado": 0.0, "planograma": 0.0, "m4u_comprar": 0.0,
                                "custo": _num(r.get("Custo unitário", "0"))}
            p["loja"] = max(0.0, _num(r.get("Estoque PDX", "0")))
            p["capacidade"] = _num(r.get("Capacidade", "0"))
            p["ultima_venda_loja"] = "" if r.get("Última Compra") in ("--", None) else r.get("Última Compra")
            if not p.get("custo"):
                p["custo"] = _num(r.get("Custo unitário", "0"))

        # movimentações: preços pagos (entradas) e saídas do CD para a loja
        hist = defaultdict(list)
        saidas30 = defaultdict(float)
        lim30 = datetime.now() - timedelta(days=30)
        for r in mov or []:
            k = r.get("Código") or r.get("Código de Barras")
            dt = _data(r.get("Data", ""))
            if not k or not dt:
                continue
            tipo, mv = r.get("Tipo", ""), r.get("Movimentação", "")
            var = _num(r.get("Variação (+/-)", "0"))
            if mv.lower().startswith("entrada") and "invent" not in tipo.lower() and var > 0:
                preco = _num(r.get("Valor custo", "0"))
                if preco > 0:
                    hist[k].append({"data": dt.strftime("%Y-%m-%d"), "preco": round(preco, 4), "qtd": var, "tipo": tipo})
            elif "picklist" in tipo.lower() and var < 0 and dt >= lim30:
                saidas30[k] += -var

        vend, dias_ok = self._vendas(c["dias_giro"])
        n_dias = max(1, dias_ok)
        T = c["dias_cobertura"]
        hoje = datetime.now()
        lista = []
        for k, p in prods.items():
            v = vend.get(p["codigo"]) or vend.get(p["barras"]) or {"qtd": 0.0, "fat": 0.0, "qtd7": 0.0, "ultima": ""}
            h = sorted(hist.get(p["codigo"]) or hist.get(p["barras"]) or [], key=lambda x: x["data"])
            media = v["qtd"] / n_dias
            media7 = v["qtd7"] / min(7, n_dias)
            total = p["cd"] + p["loja"]
            cob = (total / media) if media > 0 else None
            # quanto comprar: cobrir T dias de venda e ainda deixar a prateleira da loja cheia no fim
            alvo = math.ceil(media * T + p["capacidade"]) if media > 0 else 0
            sugestao = max(0, alvo - math.floor(total)) if media > 0 else 0
            precos = [x["preco"] for x in h]
            ult = h[-1] if h else None
            ant = next((x for x in reversed(h[:-1]) if abs(x["preco"] - ult["preco"]) > 0.001), None) if ult else None
            if media <= 0:
                status = "parado" if total > 0 else "sem_giro"
            elif total <= 0:
                status = "acabou"
            elif cob is not None and cob <= 3:
                status = "critico"
            elif cob is not None and cob < T:
                status = "acabando"
            else:
                status = "ok"
            uv = v["ultima"] or p.get("ultima_venda_loja") or ""
            dt_uv = _data(uv)
            lista.append(dict(p,
                chave=k, vendidos=round(v["qtd"], 1), vendidos7=round(v["qtd7"], 1), faturamento=round(v["fat"], 2),
                media_dia=round(media, 2), media_dia7=round(media7, 2),
                preco_venda=round(v["fat"] / v["qtd"], 2) if v["qtd"] else None,
                cobertura_dias=round(cob, 1) if cob is not None else None,
                saidas_cd30=round(saidas30.get(p["codigo"]) or saidas30.get(p["barras"]) or 0, 1),
                sugestao=sugestao, status=status,
                ultima_venda=uv, dias_sem_venda=max(0, (hoje - dt_uv).days) if dt_uv else None,
                ultimo_preco=ult["preco"] if ult else None, ultima_compra=ult["data"] if ult else None,
                ultima_compra_qtd=ult["qtd"] if ult else None,
                preco_anterior=ant["preco"] if ant else None,
                preco_medio=round(sum(x["preco"] * x["qtd"] for x in h) / sum(x["qtd"] for x in h), 4) if h else None,
                preco_min=min(precos) if precos else None, preco_max=max(precos) if precos else None,
                compras=len(h), historico=h[-8:],
                valor_cd=round(p["cd"] * (p["custo"] or 0), 2), valor_loja=round(p["loja"] * (p["custo"] or 0), 2)))
        # resumo
        com_venda = [p for p in lista if p["media_dia"] > 0]
        res = {
            "produtos_cd": sum(1 for p in lista if p["cd"] > 0), "produtos_loja": sum(1 for p in lista if p["loja"] > 0),
            "valor_cd": round(sum(p["valor_cd"] for p in lista), 2), "valor_loja": round(sum(p["valor_loja"] for p in lista), 2),
            "unidades_cd": round(sum(p["cd"] for p in lista)), "unidades_loja": round(sum(p["loja"] for p in lista)),
            "acabou": sum(1 for p in com_venda if p["status"] == "acabou"),
            "critico": sum(1 for p in com_venda if p["status"] == "critico"),
            "acabando": sum(1 for p in com_venda if p["status"] == "acabando"),
            "sem_cd_vendendo": sum(1 for p in com_venda if p["cd"] <= 0),
            "ruptura_loja": sum(1 for p in lista if p["capacidade"] > 0 and p["loja"] <= 0),
            "parados": sum(1 for p in lista if p["status"] == "parado" and p["cd"] + p["loja"] > 0),
            "valor_parado": round(sum(p["valor_cd"] + p["valor_loja"] for p in lista if p["status"] == "parado"), 2),
            "sugeridos": sum(1 for p in lista if p["sugestao"] > 0),
            "valor_sugerido": round(sum(p["sugestao"] * (p["ultimo_preco"] or p["custo"] or 0) for p in lista), 2),
            "dias_vendas": dias_ok,
        }
        ordem = {"acabou": 0, "critico": 1, "acabando": 2, "ok": 3, "parado": 4, "sem_giro": 5}
        lista.sort(key=lambda p: (ordem[p["status"]], p["cobertura_dias"] if p["cobertura_dias"] is not None else 1e9, -p["media_dia"]))
        return {"produtos": lista, "resumo": res, "calculado_em": time.time()}

    # --- lista de compras (fica no notebook; vale para qualquer aparelho) ---
    def lista(self):
        try:
            return json.load(open(self._p("lista.json"), encoding="utf-8"))
        except Exception:
            return {"itens": [], "atualizada_em": None}

    def salvar_lista(self, itens, autor=""):
        limpos = []
        for it in itens[:500]:
            limpos.append({
                "chave": str(it.get("chave", ""))[:40], "nome": str(it.get("nome", ""))[:160],
                "qtd": max(0, float(it.get("qtd") or 0)), "unidade": str(it.get("unidade", "un"))[:12],
                "ok": bool(it.get("ok")), "preco_hoje": float(it["preco_hoje"]) if it.get("preco_hoje") not in (None, "") else None,
                "obs": str(it.get("obs", ""))[:200], "manual": bool(it.get("manual")),
            })
        obj = {"itens": limpos, "atualizada_em": time.time(), "autor": str(autor)[:60]}
        self._gravar_json("lista.json", obj)
        return obj
