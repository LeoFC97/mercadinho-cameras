#!/usr/bin/env python3
# market4u.py — integração com o sistema de gestão market4u (app.market4u.com.br).
#
# O painel das câmeras usa para buscar as vendas de um dia (relatório "Últimas vendas"):
#   1) entra no market4u com o usuário da loja (a sessão fica guardada só neste servidor);
#   2) aplica o filtro de data do relatório (POST /relatorios/produtosvendido/lst/);
#   3) baixa a planilha exportada (GET /relatorios/exportar-produtos-vendidos -> CSV ';' latin-1).
# Nada é alterado no market4u: só leitura.
#
# Arquivos (pasta dados/, fora da pasta servida pelo painel e fora do Git):
#   dados/market4u_cookies.txt   sessão (cookies)
#   dados/market4u.json          usuário e, se pedido, a senha protegida (DPAPI no Windows)
#   dados/vendas/AAAA-MM-DD.csv  última planilha baixada de cada dia
import os, re, io, csv, json, time, base64, threading
import urllib.request, urllib.parse, urllib.error, http.cookiejar
from datetime import datetime, date

BASE = os.environ.get("M4U_BASE", "https://app.market4u.com.br").rstrip("/")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
TIMEOUT = 40


class Market4uErro(Exception):
    pass


class PrecisaLogin(Market4uErro):
    pass


# ---------- proteção da senha guardada ----------
def _dpapi(data: bytes, proteger: bool) -> bytes:
    """CryptProtectData/CryptUnprotectData do Windows (só o mesmo usuário/máquina abre)."""
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    inp = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out = BLOB()
    fn = ctypes.windll.crypt32.CryptProtectData if proteger else ctypes.windll.crypt32.CryptUnprotectData
    if not fn(ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out)):
        raise Market4uErro("não consegui proteger/abrir a senha guardada")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def _guardar_senha(senha: str) -> str:
    raw = senha.encode("utf-8")
    if os.name == "nt":
        return "dpapi:" + base64.b64encode(_dpapi(raw, True)).decode()
    return "b64:" + base64.b64encode(raw).decode()   # Linux/Mac: arquivo com permissão só do dono


def _abrir_senha(s: str) -> str:
    if not s:
        return ""
    kind, _, val = s.partition(":")
    raw = base64.b64decode(val)
    if kind == "dpapi":
        return _dpapi(raw, False).decode("utf-8")
    return raw.decode("utf-8")


# ---------- planilha ----------
def _limpa(v: str) -> str:
    v = (v or "").strip()
    if v.startswith('="') and v.endswith('"'):   # formato "texto" do Excel: ="0183"
        v = v[2:-1]
    return v.strip().strip('"')


def _num(v: str) -> float:
    v = _limpa(v).replace("R$", "").replace(" ", "")
    if not v:
        return 0.0
    if "," in v:
        v = v.replace(".", "").replace(",", ".")
    try:
        return float(v)
    except ValueError:
        return 0.0


def ler_planilha(raw: bytes):
    """CSV do market4u (separador ';', latin-1) -> lista de itens vendidos."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.reader(io.StringIO(txt), delimiter=";"))
    if not rows:
        return []
    head = [_limpa(h) for h in rows[0]]
    if "Data e hora" not in head:
        raise Market4uErro("a planilha veio num formato inesperado (sem a coluna 'Data e hora')")
    col = {h: i for i, h in enumerate(head)}
    g = lambda r, h: _limpa(r[col[h]]) if h in col and col[h] < len(r) else ""
    itens = []
    for r in rows[1:]:
        if not any(x.strip() for x in r):
            continue
        dh = g(r, "Data e hora")
        try:
            ep = time.mktime(datetime.strptime(dh[:19], "%Y-%m-%d %H:%M:%S").timetuple())
        except ValueError:
            ep = None
        itens.append({
            "t": ep, "datahora": dh,
            "transacao": g(r, "ID transação"),
            "cliente": g(r, "Cliente"),
            "cliente_id": g(r, "Id cliente"),
            "email": g(r, "E-mail"),
            "sexo": g(r, "Sexo"),
            "idade": g(r, "Idade"),
            "via": g(r, "VIA"),
            "pdx": g(r, "PDX"),
            "produto": g(r, "Nome do produto"),
            "codigo": g(r, "Código do produto"),
            "barras": g(r, "Código de barras"),
            "categoria": g(r, "Categoria"),
            "fabricante": g(r, "Fabricante"),
            "qtd": _num(g(r, "Quantidade")),
            "valor": round(_num(g(r, "Valor total venda")), 2),
            "custo": round(_num(g(r, "Valor total custo")), 2),
        })
    itens.sort(key=lambda x: x["datahora"], reverse=True)
    return itens


def ler_transacoes(raw: bytes):
    """CSV do relatório Transações -> {id da transação: dados da compra e do cliente}."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.reader(io.StringIO(txt), delimiter=";"))
    if not rows or "Data e hora" not in [_limpa(h) for h in rows[0]]:
        raise Market4uErro("o relatório de transações veio num formato inesperado")
    head = [_limpa(h) for h in rows[0]]
    col = {h: i for i, h in enumerate(head) if h}
    g = lambda r, h: _limpa(r[col[h]]) if h in col and col[h] < len(r) else ""
    out = {}
    for r in rows[1:]:
        if not any(x.strip() for x in r):
            continue
        tid = g(r, "ID")
        dh = g(r, "Data e hora")
        try:
            ep = time.mktime(datetime.strptime(dh[:19], "%Y-%m-%d %H:%M:%S").timetuple())
        except ValueError:
            ep = None
        nome = g(r, "Nome Cliente")
        cpf = g(r, "CPF na nota")
        out[tid] = {
            "id": tid, "t": ep, "datahora": dh, "tipo": g(r, "Tipo"), "via": g(r, "Via"),
            "cliente_id": g(r, "Cliente ID"), "nome": nome, "status_cliente": g(r, "Status Cliente"),
            "cpf_na_nota": cpf.lower().startswith("s"),
            # sem CPF na nota = consumidor genérico da maquininha (o mesmo "cliente" para todo mundo)
            "identificado": cpf.lower().startswith("s") and bool(nome) and "sem cpf" not in nome.lower(),
            "pagamento": g(r, "Forma pagamento"), "split": g(r, "Split de pg"),
            "compras_cliente": g(r, "Qtde compras"), "nao_compras_cliente": g(r, "Qtde não compras"),
            "qtd_produtos": g(r, "Qtde produtos"), "removidos": g(r, "Qtde produtos removidos"),
            "total": round(_num(g(r, "Total")), 2), "desconto": round(_num(g(r, "Desconto")), 2),
            "estorno": round(_num(g(r, "Total Estorno")), 2), "nfce": g(r, "NFC-e"),
            "voucher": round(_num(g(r, "Voucher")), 2), "cashback": round(_num(g(r, "Cashback")), 2),
            "carteira": round(_num(g(r, "Saldo Carteira")), 2),
        }
    return out


def ler_removidos(raw: bytes):
    """CSV do relatório 'Produtos removidos do carrinho' -> {id da transação: [produtos tirados do carrinho]}."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.reader(io.StringIO(txt), delimiter=";"))
    head = [_limpa(h) for h in rows[0]] if rows else []
    if "Produto" not in head:
        raise Market4uErro("o relatório de produtos removidos veio num formato inesperado")
    col = {h: i for i, h in enumerate(head) if h}
    g = lambda r, h: _limpa(r[col[h]]) if h in col and col[h] < len(r) else ""
    out = {}
    for r in rows[1:]:
        if not any(x.strip() for x in r):
            continue
        tid = g(r, "ID transação")
        prod = g(r, "Produto")
        cod, _, nome = prod.partition(" - ")
        if not nome:
            cod, nome = "", prod
        dh = g(r, "Data")
        try:
            ep = time.mktime(datetime.strptime(dh[:19], "%Y-%m-%d %H:%M:%S").timetuple())
        except ValueError:
            ep = None
        out.setdefault(tid, []).append({"produto": nome.strip(), "codigo": cod.strip(), "categoria": g(r, "Categoria"),
                                        "datahora": dh, "t": ep})
    for v in out.values():
        v.sort(key=lambda x: x["datahora"])
    return out


def deslogado(raw: bytes) -> bool:
    """O market4u devolveu a tela de login ou o aviso 'Você foi desconectado' em vez do relatório?"""
    ini = raw[:400].lstrip()
    return b"formLoginSistema" in raw or (ini.startswith(b"{") and b"desconectado" in ini)


def resumo(itens):
    trans = {i["transacao"] for i in itens if i["transacao"]}
    return {
        "itens": round(sum(i["qtd"] for i in itens), 3),
        "linhas": len(itens),
        "transacoes": len(trans),
        "total": round(sum(i["valor"] for i in itens), 2),
        "custo": round(sum(i["custo"] for i in itens), 2),
        "ultima": itens[0]["datahora"] if itens else None,
    }


# ---------- cliente ----------
class Market4u:
    def __init__(self, dados_dir):
        self.dir = dados_dir
        os.makedirs(os.path.join(dados_dir, "vendas"), exist_ok=True)
        self.cfg_path = os.path.join(dados_dir, "market4u.json")
        self.jar = http.cookiejar.LWPCookieJar(os.path.join(dados_dir, "market4u_cookies.txt"))
        try:
            self.jar.load(ignore_discard=True, ignore_expires=True)
        except (OSError, http.cookiejar.LoadError):
            pass
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.lock = threading.Lock()
        self.version_system = ""

    # --- config local ---
    def _cfg(self):
        try:
            return json.load(open(self.cfg_path, encoding="utf-8"))
        except Exception:
            return {}

    def _salvar_cfg(self, c):
        tmp = self.cfg_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(c, f)
        os.replace(tmp, self.cfg_path)
        try:
            os.chmod(self.cfg_path, 0o600)
        except OSError:
            pass

    def _salvar_cookies(self):
        try:
            self.jar.save(ignore_discard=True, ignore_expires=True)
            os.chmod(self.jar.filename, 0o600)
        except OSError:
            pass

    # --- http ---
    def _req(self, path, data=None, ajax=False, referer=None, timeout=TIMEOUT):
        url = path if path.startswith("http") else BASE + path
        body = urllib.parse.urlencode(data).encode() if isinstance(data, dict) else data
        rq = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET")
        rq.add_header("User-Agent", UA)
        rq.add_header("Accept-Language", "pt-BR,pt;q=0.9")
        if referer:
            rq.add_header("Referer", BASE + referer)
        if ajax:
            rq.add_header("X-Requested-With", "XMLHttpRequest")
            rq.add_header("Accept", "application/json, text/javascript, */*; q=0.01")
        if body is not None:
            rq.add_header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        try:
            r = self.op.open(rq, timeout=timeout)
            return r.status, r.headers, r.read(), r.geturl()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read(), url
        except urllib.error.URLError as e:
            raise Market4uErro(f"sem conexão com o market4u ({e.reason})")

    @staticmethod
    def _attr(html, pat):
        m = re.search(pat, html)
        return m.group(1) if m else ""

    def _pagina(self, path):
        st, hd, body, final = self._req(path)
        html = body.decode("utf-8", "replace")
        vs = self._attr(html, r'data-version-system="([^"]*)"')
        if vs:
            self.version_system = vs
        return st, html, final

    # --- sessão ---
    def status(self):
        c = self._cfg()
        return {"usuario": c.get("usuario", ""), "lembrar": bool(c.get("senha")),
                "conectado": bool(c.get("conectado"))}

    def _esta_logado(self):
        st, html, final = self._pagina("/relatorios/produtos-vendidos")
        return st == 200 and "formLoginSistema" not in html and 'id="body-login"' not in html

    def login(self, usuario, senha, mfa="", authenticator="", lembrar=True):
        with self.lock:
            return self._login(usuario, senha, mfa, authenticator, lembrar)

    def _login(self, usuario, senha, mfa="", authenticator="", lembrar=True):
        usuario = (usuario or "").strip()
        if not usuario or not senha:
            raise Market4uErro("informe o e-mail e a senha do market4u")
        st, html, _ = self._pagina("/")
        hash_ = self._attr(html, r'<input[^>]*name="hash"[^>]*value="([^"]*)"') or \
            self._attr(html, r'<input[^>]*id="hash"[^>]*value="([^"]*)"')
        hreq = self._attr(html, r'data-hash-request="([^"]*)"')
        if "formLoginSistema" not in html:
            # já havia sessão válida
            self._marcar(usuario, senha, lembrar)
            return {"ok": True, "estado": 1, "msg": "já conectado"}
        st, hd, body, _ = self._req("/login/request", {
            "usuario": usuario, "senha": senha, "nova_senha": "",
            "AUTHENTICATOR": authenticator or "", "MFA": mfa or "", "CELULAR": "",
            "novasenha": "0", "hash": hash_, "HASH_REQUEST": hreq, "type-post": "ajax",
        }, ajax=True, referer="/")
        try:
            res = json.loads(body.decode("utf-8", "replace") or "{}")
        except ValueError:
            raise Market4uErro(f"resposta inesperada do market4u no login (HTTP {st})")
        try:
            estado = int(res.get("estado") or 0)
        except (TypeError, ValueError):
            estado = 0
        msg = re.sub(r"<[^>]+>", " ", str(res.get("msg") or "")).strip()
        if estado == 1:
            red = res.get("redirect") or "/"
            self._req(red if red.startswith("http") else urllib.parse.urljoin(BASE + "/", red))
            if not self._esta_logado():
                raise Market4uErro("o market4u aceitou o login mas a sessão não abriu; tente de novo")
            self._marcar(usuario, senha, lembrar)
            return {"ok": True, "estado": 1, "msg": msg or "conectado"}
        out = {"ok": False, "estado": estado, "msg": msg or "não foi possível entrar"}
        if estado in (2, 3):
            out["precisa_mfa"] = True
            out["msg"] = msg or "informe o código de verificação"
        if estado == 4:
            out["precisa_mfa"] = True
            out["authenticator"] = res.get("AUTHENTICATOR", "")
            out["qrcode"] = res.get("QR_CODE", "")
            out["msg"] = msg or "cadastre o autenticador lendo o QR code e informe o código"
        if estado == 6:
            out["msg"] = msg or "o market4u pede para trocar a senha: troque pelo site e tente de novo"
        return out

    def _marcar(self, usuario, senha, lembrar):
        c = {"usuario": usuario, "conectado": True, "desde": time.time()}
        if lembrar and senha:
            try:
                c["senha"] = _guardar_senha(senha)
            except Exception:
                pass
        self._salvar_cfg(c)
        self._salvar_cookies()

    def sair(self):
        with self.lock:
            self.jar.clear()
            self._salvar_cookies()
            self._salvar_cfg({"usuario": self._cfg().get("usuario", "")})

    def _garantir_sessao(self):
        if self._esta_logado():
            return
        c = self._cfg()
        senha = ""
        try:
            senha = _abrir_senha(c.get("senha", ""))
        except Exception:
            senha = ""
        if c.get("usuario") and senha:
            r = self._login(c["usuario"], senha, lembrar=True)
            if r.get("ok"):
                return
            c["conectado"] = False
            self._salvar_cfg(c)
            raise PrecisaLogin("a sessão do market4u expirou e o login automático pediu verificação: "
                               + r.get("msg", ""))
        c["conectado"] = False
        self._salvar_cfg(c)
        raise PrecisaLogin("conecte o painel ao market4u (sessão expirada ou ainda não conectada)")

    # --- relatório ---
    def vendas(self, dia: date):
        with self.lock:
            self._garantir_sessao()
            d = dia.strftime("%d/%m/%Y")
            filtro = {"DATAHORA_DE": f"{d} 00:00", "DATAHORA_ATE": f"{d} 23:59"}
            post = {"type-post": "ajax", "full": "1", "lote": "1",
                    "DATA_JSON": json.dumps(filtro), "limparsession": "0",
                    "version-system": self.version_system}
            st, hd, body, _ = self._req("/relatorios/produtosvendido/lst/", post, ajax=True,
                                        referer="/relatorios/produtos-vendidos")
            if st == 401:
                raise PrecisaLogin("o market4u recusou a consulta (sessão expirada); conecte de novo")
            if st != 200:
                raise Market4uErro(f"o market4u respondeu HTTP {st} ao filtrar o relatório")
            st, hd, raw, _ = self._req("/relatorios/exportar-produtos-vendidos",
                                       referer="/relatorios/produtos-vendidos")
            ctype = (hd.get("Content-Type") or "").lower()
            if st != 200 or ("csv" not in ctype and "excel" not in ctype and "octet" not in ctype):
                if b"formLoginSistema" in raw:
                    raise PrecisaLogin("sessão do market4u expirada; conecte de novo")
                raise Market4uErro(f"o market4u não devolveu a planilha (HTTP {st}, {ctype or 'sem tipo'})")
            itens = ler_planilha(raw)
            # confere que o filtro pegou (todas as linhas do dia pedido)
            alvo = dia.strftime("%Y-%m-%d")
            fora = [i for i in itens if not i["datahora"].startswith(alvo)]
            if fora and len(fora) == len(itens):
                raise Market4uErro("o market4u devolveu outro dia; tente buscar de novo")
            itens = [i for i in itens if i["datahora"].startswith(alvo)]
            path = os.path.join(self.dir, "vendas", alvo + ".csv")
            with open(path + ".tmp", "wb") as f:
                f.write(raw)
            os.replace(path + ".tmp", path)
            self._salvar_cookies()
            c = self._cfg()
            if not c.get("conectado"):
                c["conectado"] = True
                self._salvar_cfg(c)
            r = {"dia": alvo, "buscado_em": time.time(), "itens": itens, "resumo": resumo(itens)}
            try:
                r["transacoes"] = self._transacoes(dia)
            except Exception as e:
                r["transacoes"] = self.transacoes_guardadas(dia)
                r["transacoes_erro"] = str(e)
            try:
                r["removidos"] = self._removidos(dia)
            except Exception as e:
                r["removidos"] = self.removidos_guardados(dia)
                r["removidos_erro"] = str(e)
            return r

    def _transacoes(self, dia: date):
        """Relatório Transações do dia (dados do cliente de cada compra). Não depende de filtro na sessão:
        o filtro vai no próprio endereço da exportação."""
        d = dia.strftime("%d/%m/%Y")
        post = {"type-post": "ajax", "full": "1", "action_": "busca",
                "DATA_JSON": json.dumps({"DATAHORA_DE": f"{d} 00:00", "DATAHORA_ATE": f"{d} 23:59"}),
                "busca": "", "version-system": "app"}
        q = urllib.parse.urlencode({"_action": "exportar", "POST": base64.b64encode(json.dumps(post).encode()).decode()})
        # o market4u leva uns 10-15 s por dia para gerar este relatório
        st, hd, raw, _ = self._req("/parametros/cliente/lsttransacoes//IDENTIFICADOR/?" + q, referer="/relatorios/transacoes", timeout=180)
        if deslogado(raw):
            raise PrecisaLogin("o market4u encerrou a sessão do painel; conecte de novo")
        if st != 200:
            raise Market4uErro(f"o market4u não devolveu as transações (HTTP {st})")
        tx = ler_transacoes(raw)
        path = os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + "_transacoes.csv")
        with open(path + ".tmp", "wb") as f:
            f.write(raw)
        os.replace(path + ".tmp", path)
        return tx

    def _removidos(self, dia: date):
        """Relatório 'Produtos removidos do carrinho' das transações do dia (quais itens a pessoa tirou)."""
        d = dia.strftime("%d/%m/%Y")
        post = {"type-post": "ajax", "full": "1", "lote": "1",
                "DATA_JSON": json.dumps({"DATAHORA_DE": f"{d} 00:00", "DATAHORA_ATE": f"{d} 23:59"}),
                "limparsessao": "0", "version-system": "app"}
        q = urllib.parse.urlencode({"_action": "exportar", "POST": base64.b64encode(json.dumps(post).encode()).decode()})
        st, hd, raw, _ = self._req("/relatorios/produtoabandonado/lst/?" + q, referer="/relatorios/produtos-abandonados", timeout=90)
        if deslogado(raw):
            raise PrecisaLogin("o market4u encerrou a sessão do painel; conecte de novo")
        if st != 200:
            raise Market4uErro(f"o market4u não devolveu os produtos removidos (HTTP {st})")
        rem = ler_removidos(raw)
        path = os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + "_removidos.csv")
        with open(path + ".tmp", "wb") as f:
            f.write(raw)
        os.replace(path + ".tmp", path)
        return rem

    def removidos_guardados(self, dia: date):
        path = os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + "_removidos.csv")
        try:
            return ler_removidos(open(path, "rb").read())
        except Exception:
            return {}

    def transacoes_guardadas(self, dia: date):
        path = os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + "_transacoes.csv")
        try:
            return ler_transacoes(open(path, "rb").read())
        except Exception:
            return {}

    def vendas_cache(self, dia: date, max_idade=120, permitir_velho=True):
        """Vendas do dia usando a planilha já baixada quando ela ainda vale:
        dia passado baixado depois do fim do dia -> definitiva; hoje -> se tiver menos de max_idade s.
        Sem sessão no market4u, devolve a última planilha guardada (marcada como 'velha')."""
        path = os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + ".csv")
        alvo = dia.strftime("%Y-%m-%d")
        def do_arquivo(velha):
            itens = [i for i in ler_planilha(open(path, "rb").read()) if i["datahora"].startswith(alvo)]
            return {"dia": alvo, "buscado_em": os.path.getmtime(path), "itens": itens,
                    "resumo": resumo(itens), "cache": True, "velha": velha,
                    "transacoes": self.transacoes_guardadas(dia), "removidos": self.removidos_guardados(dia)}
        if os.path.isfile(path):
            mt = os.path.getmtime(path)
            fim_dia = time.mktime(dia.timetuple()) + 86400
            if (dia < date.today() and mt > fim_dia + 600) or (time.time() - mt < max_idade):
                return do_arquivo(False)
        try:
            return self.vendas(dia)
        except Market4uErro:
            if permitir_velho and os.path.isfile(path):
                return do_arquivo(True)
            raise

    # --- vários dias de uma vez (Dashboard) ---
    def _arq(self, dia, suf=""):
        return os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + suf + ".csv")

    @staticmethod
    def _definitivo(paths, dia, max_idade):
        """Arquivos existem e foram baixados depois do fim do dia (não mudam mais) ou há pouco tempo."""
        if not all(os.path.isfile(p) for p in paths):
            return False
        mt = min(os.path.getmtime(p) for p in paths)
        fim_dia = time.mktime(dia.timetuple()) + 86400
        return mt > fim_dia + 600 or time.time() - mt < max_idade

    def vendas_ok(self, dia: date, max_idade=600):
        return self._definitivo([self._arq(dia)], dia, max_idade)

    def detalhes_ok(self, dia: date, max_idade=1800):
        return self._definitivo([self._arq(dia, "_transacoes"), self._arq(dia, "_removidos")], dia, max_idade)

    @staticmethod
    def _csv_linhas(raw: bytes):
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                txt = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        rows = [r for r in csv.reader(io.StringIO(txt), delimiter=";")]
        return (rows[0], [r for r in rows[1:] if any(x.strip() for x in r)]) if rows else ([], [])

    def _gravar_dia(self, path, head, rows):
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
        w.writerow(head)
        w.writerows(rows)
        with open(path + ".tmp", "wb") as f:
            f.write(buf.getvalue().encode("cp1252", "replace"))
        os.replace(path + ".tmp", path)

    def _baixar_vendas_trecho(self, de: date, ate: date):
        """Planilha de vendas de vários dias seguidos (uma exportação só, rápida) -> um arquivo por dia."""
        from datetime import timedelta
        d1, d2 = de.strftime("%d/%m/%Y"), ate.strftime("%d/%m/%Y")
        filtro = {"DATAHORA_DE": f"{d1} 00:00", "DATAHORA_ATE": f"{d2} 23:59"}
        dias, d = [], de
        while d <= ate:
            dias.append(d.strftime("%Y-%m-%d"))
            d += timedelta(days=1)
        with self.lock:
            self._garantir_sessao()
            post = {"type-post": "ajax", "full": "1", "lote": "1", "DATA_JSON": json.dumps(filtro),
                    "limparsession": "0", "version-system": self.version_system}
            st, hd, body, _ = self._req("/relatorios/produtosvendido/lst/", post, ajax=True, referer="/relatorios/produtos-vendidos")
            if st == 401 or deslogado(body):
                raise PrecisaLogin("o market4u recusou a consulta (sessão expirada); conecte de novo")
            if st != 200:
                raise Market4uErro(f"o market4u respondeu HTTP {st} ao filtrar o relatório")
            st, hd, raw, _ = self._req("/relatorios/exportar-produtos-vendidos", referer="/relatorios/produtos-vendidos", timeout=120)
            if deslogado(raw):
                raise PrecisaLogin("sessão do market4u expirada; conecte de novo")
            if st != 200:
                raise Market4uErro(f"o market4u não devolveu a planilha (HTTP {st})")
            self._salvar_cookies()
        head, rows = self._csv_linhas(raw)
        hl = [_limpa(h) for h in head]
        if "Data e hora" not in hl:
            raise Market4uErro("a planilha veio num formato inesperado")
        ih = hl.index("Data e hora")
        vendas = {k: [] for k in dias}
        for r in rows:
            k = _limpa(r[ih])[:10] if ih < len(r) else ""
            if k in vendas:
                vendas[k].append(r)
        if rows and not any(vendas.values()):
            raise Market4uErro("o market4u devolveu outro período; tente de novo")
        for k in dias:
            self._gravar_dia(self._arq(datetime.strptime(k, "%Y-%m-%d").date()), head, vendas[k])

    def garantir_vendas(self, de: date, ate: date, max_idade=600):
        """Baixa as planilhas de vendas que faltam no período (blocos de até 62 dias). Devolve quantos dias baixou."""
        from datetime import timedelta
        ate = min(ate, date.today())
        falta, d = [], de
        while d <= ate:
            if not self.vendas_ok(d, max_idade):
                falta.append(d)
            d += timedelta(days=1)
        blocos = []
        for d in falta:
            if blocos and (d - blocos[-1][1]).days == 1 and (d - blocos[-1][0]).days < 62:
                blocos[-1][1] = d
            else:
                blocos.append([d, d])
        for a, b in blocos:
            self._baixar_vendas_trecho(a, b)
        return len(falta)

    def baixar_detalhes(self, dia: date):
        """Transações (clientes, pagamento) e removidos de um dia. O market4u é lento aqui (~10-15 s por dia),
        e essas exportações não usam o filtro da sessão, então não seguram a trava das outras consultas."""
        with self.lock:
            self._garantir_sessao()
        self._transacoes(dia)
        self._removidos(dia)
        self._salvar_cookies()

    def planilha(self, dia: date):
        path = os.path.join(self.dir, "vendas", dia.strftime("%Y-%m-%d") + ".csv")
        return path if os.path.isfile(path) else None
