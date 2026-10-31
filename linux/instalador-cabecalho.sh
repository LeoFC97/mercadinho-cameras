#!/bin/bash
# =====================================================================
#  Instalador do servidor de câmeras — Mercadinho (Ubuntu 26.04 Server)
#  Uso:  sudo bash instalar-mercadinho.sh
#  Instala: go2rtc (ao vivo), painel React (ao vivo + Revisão), gravador
#  com detecção de movimento, Tailscale (acesso remoto seguro), firewall,
#  e deixa o notebook sem dormir ao fechar a tampa. Tudo sobe sozinho.
# =====================================================================
set -euo pipefail
APP=/opt/mercadinho-cameras
ETC=/etc/mercadinho
GO2RTC_VER=v1.9.14
TESTE="${MERCADINHO_TESTE:-0}"           # 1 = modo teste (sem apt/systemd/firewall/tailscale)
[ "$TESTE" = 1 ] && { APP="${MERCADINHO_PREFIXO:-/tmp/mtest}/opt/mercadinho-cameras"; ETC="${MERCADINHO_PREFIXO:-/tmp/mtest}/etc/mercadinho"; }

azul(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m✓\033[0m %s\n' "$*"; }
aviso(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
pergunta(){ local v; if [ -r /dev/tty ]; then read -r "$@" v </dev/tty; else v=""; fi; printf '%s' "$v"; }

#__PAYLOAD__

[ "$TESTE" = 1 ] || [ "$(id -u)" = 0 ] || { echo "Rode com sudo:  sudo bash $0"; exit 1; }

azul "Servidor de câmeras do Mercadinho"
echo "Isso vai levar alguns minutos. Precisa de internet."

# ---------------- 1) pacotes ----------------
if [ "$TESTE" != 1 ]; then
  azul "1/8 Instalando pacotes do sistema"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ffmpeg python3 curl ca-certificates ufw openssh-server iproute2 iputils-ping wpasupplicant >/dev/null
  ok "ffmpeg, python3, firewall, ssh"
  id cameras >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin cameras
  ok "usuário de serviço 'cameras'"
fi

# ---------------- 2) arquivos do sistema ----------------
azul "2/8 Copiando o sistema para $APP"
mkdir -p "$APP" "$ETC" "$APP/ui/rec"
TMPX=$(mktemp -d)
payload | base64 -d | tar -xz -C "$TMPX"
cp -r "$TMPX"/. "$APP"/          # não sobrescreve go2rtc.yaml, ui/rec, senha (não vêm no pacote)
rm -rf "$TMPX"
chmod 755 "$APP"/*.sh "$APP"/*.py "$APP/mercadinho"
[ "$TESTE" = 1 ] || install -m 755 "$APP/mercadinho" /usr/local/bin/mercadinho
ok "painel, gravador e ferramentas"

# ---------------- 3) go2rtc ----------------
azul "3/8 Baixando o go2rtc ($GO2RTC_VER)"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Processador não suportado: $(uname -m)"; exit 1 ;;
esac
curl -fsSL --retry 3 -o "$APP/go2rtc.novo" "https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VER/go2rtc_linux_$ARCH"
chmod 755 "$APP/go2rtc.novo"; mv -f "$APP/go2rtc.novo" "$APP/go2rtc"
ok "go2rtc linux_$ARCH"

# ---------------- 4) senha + câmeras ----------------
azul "4/8 Câmeras"
if [ -s "$ETC/senha" ] && [ -z "${MERCADINHO_SENHA:-}" ]; then
  ok "senha RTSP já configurada (para trocar: sudo mercadinho senha)"
else
  PW="${MERCADINHO_SENHA:-}"
  while [ -z "$PW" ]; do
    PW=$(pergunta -s -p "Senha RTSP das câmeras (a mesma que funcionou no painel do Mac): "); echo
  done
  ( umask 077; printf '%s' "$PW" > "$ETC/senha" )
fi
echo "Procurando câmeras na rede (uns 30s)..."
( cd "$APP" && timeout 120 python3 scan_cameras.py >/dev/null 2>&1 ) || true
python3 "$APP/setup_cameras.py" --senha-arquivo "$ETC/senha" ${MERCADINHO_SEM_TESTE:+--sem-teste}

# ---------------- 5) configuração do gravador ----------------
azul "5/8 Gravação (teto de disco automático)"
LIVRE=$(df -BG --output=avail "$APP" | tail -1 | tr -dc '0-9')
CAP=$(( LIVRE * 6 / 10 - 5 )); [ "$CAP" -lt 5 ] && CAP=5; [ "$CAP" -gt 500 ] && CAP=500
PISO=$(( LIVRE / 10 )); [ "$PISO" -lt 5 ] && PISO=5; [ "$PISO" -gt 20 ] && PISO=20
if [ ! -f "$APP/gravador.env" ]; then
  cat > "$APP/gravador.env" <<GE
# Ajustes do gravador (edite e rode: sudo mercadinho reiniciar)
REC_STREAM=sub            # sub = econômico | main = HD 1080p
CAP_GB=$CAP               # tamanho máximo das gravações
FREE_FLOOR_GB=$PISO       # nunca deixar o disco com menos que isso
RETENTION_HOURS=168       # guarda até 7 dias
GRACE_HOURS=2             # últimas 2h sempre completas (mesmo sem movimento)
MOTION_THRESHOLD=0.8      # sensibilidade (menor = guarda mais)
GE
fi
ok "teto ${CAP} GB (livre agora: ${LIVRE} GB), retenção 7 dias"

if [ "$TESTE" = 1 ]; then azul "MODO TESTE: parando antes de systemd/firewall/tailscale"; ok "arquivos em $APP"; exit 0; fi
chown -R cameras:cameras "$APP"; chmod 600 "$APP/go2rtc.yaml"

# ---------------- 6) serviços (sobem sozinhos ao ligar) ----------------
azul "6/8 Serviços"
cat > /etc/systemd/system/mercadinho-go2rtc.service <<U
[Unit]
Description=Mercadinho - go2rtc (câmeras ao vivo)
After=network-online.target
Wants=network-online.target
[Service]
User=cameras
WorkingDirectory=$APP
ExecStart=$APP/go2rtc -config $APP/go2rtc.yaml
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
U
cat > /etc/systemd/system/mercadinho-painel.service <<U
[Unit]
Description=Mercadinho - painel web (porta 8099)
After=network-online.target
[Service]
User=cameras
WorkingDirectory=$APP/ui
ExecStart=/usr/bin/python3 -m http.server 8099 --bind 0.0.0.0
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
U
cat > /etc/systemd/system/mercadinho-gravador.service <<U
[Unit]
Description=Mercadinho - gravador com detecção de movimento
After=mercadinho-go2rtc.service
Wants=mercadinho-go2rtc.service
[Service]
User=cameras
WorkingDirectory=$APP
EnvironmentFile=$APP/gravador.env
ExecStart=$APP/gravador-run.sh
KillMode=control-group
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload
systemctl enable --now mercadinho-go2rtc mercadinho-painel mercadinho-gravador >/dev/null 2>&1
ok "go2rtc, painel e gravador ligados (sobem sozinhos no boot)"

# ---------------- 7) notebook como servidor ----------------
azul "7/8 Notebook como servidor"
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/mercadinho.conf <<L
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
L
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
ok "não dorme mais (nem fechando a tampa)"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
ok "firewall: só SSH e Tailscale entram (câmeras não ficam expostas)"

# ---------------- 8) Tailscale ----------------
azul "8/8 Acesso remoto (Tailscale)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
if tailscale status >/dev/null 2>&1; then
  ok "Tailscale já conectado"
else
  R=$(pergunta -p "Conectar o Tailscale agora? (aparece um QR code pra aprovar no celular) [S/n]: ")
  if [ "${R,,}" != "n" ]; then
    tailscale up --ssh --hostname=mercadinho-cameras --qr || aviso "Tailscale não conectou. Depois rode: sudo tailscale up --ssh --hostname=mercadinho-cameras --qr"
  else
    aviso "Pulei. Depois rode: sudo tailscale up --ssh --hostname=mercadinho-cameras --qr"
  fi
fi
systemctl restart mercadinho-go2rtc   # pega o IP do Tailscale para WebRTC

azul "Pronto!"
sleep 3
mercadinho status || true
cat <<FIM

Abra o painel de qualquer computador/celular com Tailscale no endereço acima.
Comandos úteis:  mercadinho status | sudo mercadinho reconfigurar | sudo mercadinho wifi "REDE" "senha"
FIM
exit 0
