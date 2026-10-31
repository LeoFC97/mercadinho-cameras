#!/bin/bash
# Gravador das câmeras (detecção de movimento + teto de disco).
# Grava o sub-stream em segmentos; o gravador.py mantém só os trechos com movimento.
cd "$(dirname "$0")/../app"   # tudo roda a partir de app/
FFMPEG="/opt/homebrew/bin/ffmpeg"; [ -x "$FFMPEG" ] || FFMPEG="ffmpeg"
SEG=12
PW=$(cat senha_teste.txt 2>/dev/null)
if [ -z "$PW" ]; then echo "Falta senha_teste.txt (senha RTSP)."; read -p "Enter"; exit 1; fi
mkdir -p ui/rec scan

PIDS=()
cleanup(){ echo; echo "Encerrando gravador..."; kill "${PIDS[@]}" 2>/dev/null; pkill -P $$ 2>/dev/null; exit 0; }
trap cleanup EXIT INT TERM

echo "Iniciando captura das câmeras..."
while read -r CAM IP; do
  [ -z "$CAM" ] && continue
  mkdir -p "ui/rec/$CAM"
  URL="rtsp://admin:${PW}@${IP}:554/cam/realmonitor?channel=1&subtype=1"
  OUT="ui/rec/$CAM/%Y%m%d_%H%M%S.mp4"
  ( while true; do
      "$FFMPEG" -nostdin -loglevel warning -rtsp_transport tcp -i "$URL" \
        -an -c copy -f segment -segment_time $SEG -reset_timestamps 1 -strftime 1 -segment_format_options movflags=+faststart "$OUT"
      echo "[$CAM] ffmpeg saiu; reconectando em 2s..." >> scan/gravador.log
      sleep 2
    done ) &
  PIDS+=($!)
  echo "  gravando $CAM ($IP)"
done < <(python3 ../mac/rec_targets.py)

echo "Iniciando manutenção (movimento/índice/retenção)..."
( python3 -u gravador.py >> scan/gravador.log 2>&1 ) &
PIDS+=($!)

echo "============================================================"
echo "  GRAVANDO ${#PIDS[@]} processos. Arquivos em ui/rec/"
echo "  Veja a revisão no painel (4-painel.command) -> aba 'Revisão'."
echo "  Para PARAR a gravação: feche esta janela (ou Ctrl+C)."
echo "============================================================"
wait
