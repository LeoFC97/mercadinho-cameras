# Câmeras do Mercadinho

Sistema de câmeras para as Intelbras **iM3 C** (Wi‑Fi) do mercadinho. Ele faz quatro coisas:

- junta todas as câmeras num **feed central** (go2rtc);
- mostra um **painel React** com o ao vivo e uma tela de **Revisão**, onde você volta no tempo com todas as câmeras sincronizadas;
- **grava só quando há movimento**;
- permite **acesso remoto** via Tailscale.

Tudo roda num computador dedicado à loja, ligado 24/7 (Windows ou Linux), sem depender de nuvem.

```
câmeras (RTSP, Wi-Fi) ──► go2rtc :1984 / :8554 ──► painel  http://<servidor>:8099
                                    │                 ├─ Ao vivo (WebRTC/MSE)
                                    └──► ffmpeg ──►   └─ Revisão (gravações sincronizadas)
                                         segmentos de 12s ─► gravador.py (movimento, índice, limpeza)
```

## Estrutura

| Pasta | O que tem |
|---|---|
| `app/` | Código comum: painel (`ui/`), gravador, varredura/configuração das câmeras e supervisor. |
| `windows/` | Corpo do instalador PowerShell e `build.py`, que gera o `.bat` único. |
| `linux/` | Cabeçalho do instalador, `build.sh`, serviço do gravador e o CLI `mercadinho`. |
| `mac/` | Atalhos `.command` para rodar no Mac (uso manual, sem serviço). |

### Principais arquivos em `app/`
- `supervisor.py` — mantém tudo de pé: go2rtc, painel, uma gravação ffmpeg por câmera e a manutenção. Reinicia o que cair e escreve `logs/status.json`.
- `painel_server.py` — servidor do painel. Suporta HTTP Range, necessário para o Safari/iPhone tocar as gravações.
- `gravador.py` — calcula o movimento de cada segmento e mantém só os trechos com movimento (± 2 segmentos de folga). Também gera o índice por câmera/dia e aplica o teto de disco.
- `scan_cameras.py` → `setup_cameras.py` → `gen_config.py` — acham as câmeras na rede, testam a senha e geram o `go2rtc.yaml` e o `ui/config.js`.
- `ui/` — painel React (React + htm embarcados em `ui/vendor/`, funciona sem internet).

## Instalar

Os instaladores são um arquivo único, com tudo embutido, e ficam nas **Releases**. Para gerar a partir do código:

```bash
python3 windows/build.py    # -> dist/instalar-cameras-mercadinho.bat
bash linux/build.sh         # -> dist/instalar-mercadinho.sh
```

### Windows (notebook servidor)
Rode `instalar-cameras-mercadinho.bat` e aceite o pedido de administrador. O instalador:

1. Instala tudo em `C:\MercadinhoCameras`: Python embutido, ffmpeg e go2rtc.
2. Procura as câmeras e pede a senha RTSP.
3. Cria a tarefa agendada **"Mercadinho Cameras"**, que roda como SYSTEM no boot, sem login, com um vigia a cada 5 minutos.
4. Impede o notebook de dormir, inclusive com a tampa fechada.
5. Configura o firewall para liberar o painel só pela faixa do Tailscale.
6. Instala o Tailscale para acesso de fora.

Se as câmeras mudarem de IP, use o atalho **Reconfigurar câmeras** na área de trabalho.
O log da instalação fica em `C:\MercadinhoCameras\logs\instalacao.log`.

### Linux (Ubuntu/Debian)
Rode `sudo bash instalar-mercadinho.sh`. Ele cria os serviços systemd `mercadinho-go2rtc`, `mercadinho-painel` e `mercadinho-gravador`, além do ufw, do logind (tampa) e do Tailscale.
Para administrar, use `mercadinho status`, `mercadinho logs`, `sudo mercadinho reconfigurar`, `sudo mercadinho senha`.

### Mac (manual)
Use os atalhos de `mac/`, que rodam a partir de `app/`:

1. `1-procurar-cameras`
2. `2b-testar-senha`, com a senha em `app/senha_teste.txt`
3. `4-painel`
4. `5-gravador`

O binário do go2rtc para macOS deve ficar em `app/go2rtc`.

## Gravação: parâmetros

Os parâmetros ficam em `gravador.env` no servidor, ou em variáveis de ambiente:

| Variável | Padrão | Função |
|---|---|---|
| `GRACE_HOURS` | 2 | As últimas N horas nunca são apagadas, mesmo sem movimento. |
| `MOTION_THRESHOLD` | 0.8 | Sensibilidade do movimento: maior guarda menos, menor guarda mais. |
| `CAP_GB` / `FREE_FLOOR_GB` | 18 / 12 | Teto de disco: apaga o mais antigo antes de encher. |
| `RETENTION_HOURS` | 72 | Idade máxima das gravações. |
| `REC_STREAM` | sub | `sub` (leve) ou `main` (1080p). |

## Segurança
- **A senha das câmeras nunca entra no repositório.** Ela é pedida na instalação e fica só no servidor (`go2rtc.yaml`), que está no `.gitignore`.
- Não exponha as portas 1984, 8554 ou 8099 para a internet. Para acessar de fora, use o Tailscale.
- Recomendado: reservar IP fixo para cada câmera no roteador (DHCP por MAC).

## Próximos passos
- IA para identificar os produtos retirados das prateleiras, treinada na RTX 30 e rodando no servidor.
