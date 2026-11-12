# Rede neural dos produtos — ponto de partida para continuar no Claude Code

Contexto para quem (pessoa ou Claude) for continuar a IA das câmeras do mercadinho a partir daqui.
Abra este repositório no Claude Code (de preferência no PC com a RTX) e peça: *"leia rede_neural/README.md e vamos continuar"*.

## Objetivo

Reconhecer **qual produto** a pessoa pega nas imagens das 5 câmeras da loja (market4u, Condomínio Mondrian Life),
para cruzar com as vendas do market4u e achar **retiradas sem venda** (furtos) revendo as gravações do passado.
A IA é só para identificar produtos — não é reconhecimento de pessoas.

## O que já existe (tudo neste repositório)

| Parte | Onde | Situação |
|---|---|---|
| Servidor 24h | notebook **Juliana** (Windows), `C:\MercadinhoCameras` | grava as 5 câmeras, painel em `http://100.117.219.7:8099` (Tailscale) |
| Câmeras | Intelbras iM3 C, só Wi‑Fi, 1920×1080 H.264 ~12–15 q/s | nomes fixos por MAC (`dados/cameras_mac.json`), hoje `cam_133…cam_139` |
| Gravações | `app/ui/rec/<cam>/AAAAMMDD_HHMMSS.mp4` (trechos de 12 s) + índice `AAAA-MM-DD.json` `{arquivo: {t, d, m}}` | por padrão grava o stream leve; `REC_STREAM=main` em `gravador.env` grava em HD |
| **Catálogo e fotos para a IA** | `app/ia.py` + aba **IA** do painel (`app/ui/ia.js`) | fotos ao vivo em HD ou tiradas das gravações (inclusive nos horários das vendas), marcação de caixas por produto, status pendente/rotulada/fundo |
| Dados da IA | `C:\MercadinhoCameras\dados\ia\` (fora do Git, **nunca apagado pela limpeza**) | `classes.json`, `imagens/`, `rotulos/<id>.json` (caixas x,y,w,h de 0 a 1), `lixeira/` |
| Exportação | aba IA → **Exportar pacote** (ou `GET /api/ia/exportar.zip` após `POST /api/ia/exportar`) | `dataset_yolo.zip`: formato YOLO/Ultralytics, `data.yaml`, `produtos.csv`, divisão fixa ~80/20 por hash do id da imagem |
| Script de treino | `rede_neural/treinar.py` (+ `TREINO.md`) | parâmetros fixos para comparar treinos; grava `resultado.json` e uma linha em `historico.csv` |
| Zonas de prateleira | `app/prateleiras.py` + aba Prateleiras | heurística sem IA: detecta mexida numa zona e qual item (retângulo) mudou, compara antes × depois |
| Vendas | `app/market4u.py` | o market4u pôs captcha no login; hoje as vendas entram **importando a planilha** exportada do market4u |

### Números do dataset (exportação de 04/11/2026)

- 536 imagens (423 treino / 113 validação), **45 produtos com marcação**, 261 caixas, 188 fotos com produto e 348 de fundo.
- A maioria dos produtos tem só **1–10 marcações** — pouco. Os com mais: Schweppes Citrus 1,5 L (19), Coca Sem Açúcar 1,5 L (15),
  Ketchup Predilecta (14), Monster Ultra (13), H2OH Limoneto (12), Paçoquita (12).
- Ainda **não houve nenhum treino de verdade** (o primeiro, preliminar, foi interrompido para rodar no PC com a RTX).

## Próximos passos sugeridos

1. **Treino base (linha de comparação)** no PC com RTX série 30:
   exportar o pacote mais recente → descompactar → `python rede_neural/treinar.py C:\ia\dataset C:\ia\treinos\<data>`
   (padrão: `yolo11s.pt`, 960 px, 100 épocas, até 150 fotos de fundo). Guardar `historico.csv` e o `best.pt`.
2. **Mais dados onde importa**: meta de 100–150 caixas por produto, de câmeras e ângulos diferentes. Priorizar os produtos que mais vendem
   (Dashboard → Produtos / curva A). Usar a captura "nos horários das vendas" da aba IA — a venda diz qual produto deve aparecer.
3. **Pré-rotulagem**: com um primeiro modelo, sugerir as caixas automaticamente na aba IA (a pessoa só confirma/corrige).
   Caminho: endpoint no painel que roda o `best.pt` (ou ONNX) numa foto pendente e preenche `rotulos/<id>.json` como sugestão.
4. **Recortes em vez de quadro inteiro**: os produtos ocupam poucos pixels nas câmeras de teto; testar treino em recortes das zonas
   de prateleira/geladeira (as zonas já existem em `dados/prateleiras/config.json`) e/ou `imgsz` maior.
5. **Inferência**: o notebook Juliana é fraco (CPU, sem GPU). Opções: rodar só nos trechos com movimento perto das zonas, exportar para
   ONNX/OpenVINO, ou processar à noite em lote; alternativa é o PC com RTX processar as gravações pela rede.
6. **Juntar com prateleiras + vendas**: evento de prateleira ("item saiu da zona X às 14:03") + produto reconhecido + venda do market4u
   no mesmo minuto → lista de "retiradas sem venda" para revisar na aba Ocorrências.

## Regras do projeto (não quebrar)

- **Nunca** commitar senha das câmeras ou segredos: `senha*.txt`, `chaves.txt`, `go2rtc.yaml`, `ui/config.js`, `gravador.env`, `dados/`.
- Fotos da IA, clipes e tudo em `dados/` **nunca** são apagados pela limpeza de disco (ela só mexe em `ui/rec/`).
- O notebook atualiza sozinho do GitHub a cada 10 min (`supervisor.py`); mudança só no painel não para a gravação,
  mas mudar `supervisor.py` reinicia tudo.
- Não mexer em exclusões do antivírus/Defender.
- Interface e textos em português, para quem não é técnico.

## Arquivos úteis para começar

- `app/ia.py` — formato dos rótulos e a exportação (`exportar()`, `COMO_TREINAR`).
- `app/ui/ia.js` — tela de catálogo/marcação.
- `app/prateleiras.py` — zonas e o analisador antes × depois.
- `app/gravador.py` — formato das gravações e índices.
- `rede_neural/treinar.py`, `rede_neural/TREINO.md` — treino e histórico.
