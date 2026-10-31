#!/usr/bin/env python3
# ocorrencias.py — ocorrências marcadas no painel (possível furto, algo para conferir...).
# Cada uma guarda: horário, câmeras, título, descrição, quem marcou, status, comentários,
# histórico de mudanças e o clipe exportado (prova que não some quando a gravação é limpa).
# Arquivo: dados/ocorrencias.json
import os, json, time, threading, secrets

STATUS = ["aberta", "analisando", "confirmada", "descartada", "resolvida"]
ROTULO = {"aberta": "Aberta", "analisando": "Em análise", "confirmada": "Furto confirmado",
          "descartada": "Descartada", "resolvida": "Resolvida"}


def _txt(v, n):
    return str(v or "").strip()[:n]


class Ocorrencias:
    def __init__(self, dados_dir):
        os.makedirs(dados_dir, exist_ok=True)
        self.path = os.path.join(dados_dir, "ocorrencias.json")
        self.lock = threading.Lock()

    def _ler(self):
        try:
            return json.load(open(self.path, encoding="utf-8"))
        except Exception:
            return []

    def _gravar(self, lst):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lst, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def listar(self):
        with self.lock:
            return sorted(self._ler(), key=lambda o: o.get("t", 0), reverse=True)

    def obter(self, oid):
        return next((o for o in self.listar() if o["id"] == oid), None)

    def criar(self, d):
        try:
            t = float(d.get("t"))
        except (TypeError, ValueError):
            raise ValueError("horário inválido")
        autor = _txt(d.get("autor"), 60)
        if not autor:
            raise ValueError("informe o seu nome")
        titulo = _txt(d.get("titulo"), 120) or "Ocorrência"
        agora = time.time()
        o = {
            "id": time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + "-" + secrets.token_hex(2),
            "t": round(t, 1),
            "titulo": titulo,
            "descricao": _txt(d.get("descricao"), 4000),
            "autor": autor,
            "cameras": [str(c)[:64] for c in (d.get("cameras") or [])][:16],
            "status": "aberta",
            "criado_em": agora,
            "atualizado_em": agora,
            "venda": d.get("venda") if isinstance(d.get("venda"), dict) else None,
            "clipe": None,
            "comentarios": [],
            "historico": [{"em": agora, "autor": autor, "acao": "marcou a ocorrência"}],
        }
        with self.lock:
            lst = self._ler()
            lst.append(o)
            self._gravar(lst)
        return o

    def _mudar(self, oid, fn):
        with self.lock:
            lst = self._ler()
            for o in lst:
                if o["id"] == oid:
                    fn(o)
                    o["atualizado_em"] = time.time()
                    self._gravar(lst)
                    return o
        raise KeyError("ocorrência não encontrada")

    def atualizar(self, oid, d):
        autor = _txt(d.get("autor"), 60)
        if not autor:
            raise ValueError("informe o seu nome")

        def fn(o):
            agora = time.time()
            if "status" in d and d["status"] != o["status"]:
                if d["status"] not in STATUS:
                    raise ValueError("status inválido")
                o["historico"].append({"em": agora, "autor": autor,
                                       "acao": f"mudou para \"{ROTULO[d['status']]}\""})
                o["status"] = d["status"]
            for k, n in (("titulo", 120), ("descricao", 4000)):
                if k in d and _txt(d[k], n) != o.get(k):
                    o[k] = _txt(d[k], n) or o.get(k)
                    o["historico"].append({"em": agora, "autor": autor, "acao": f"editou {k}"})
            if d.get("comentario"):
                o["comentarios"].append({"em": agora, "autor": autor, "texto": _txt(d["comentario"], 4000)})
        return self._mudar(oid, fn)

    def definir_clipe(self, oid, clipe_id):
        def fn(o):
            o["clipe"] = clipe_id
        return self._mudar(oid, fn)

    def apagar(self, oid):
        with self.lock:
            lst = self._ler()
            novo = [o for o in lst if o["id"] != oid]
            if len(novo) == len(lst):
                raise KeyError("ocorrência não encontrada")
            self._gravar(novo)
