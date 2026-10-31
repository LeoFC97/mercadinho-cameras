#!/bin/bash
# Gravador (servidor): grava cada câmera puxando do go2rtc local (1 conexão por câmera),
# em segmentos; o gravador.py mantém só os trechos com movimento + folga.
cd "$(dirname "$0")"
SEG="${SEG_SECONDS:-12}"; SEG="${SEG%.*}"
SUF=""; [ "${REC_STREAM:-sub}" = "sub" ] && SUF="_sub"
mkdir -p ui/rec
# espera o go2rtc subir
for i in $(seq 1 60); do curl -s http://127.0.0.1:1984/api/streams >/dev/null && break; sleep 1; done
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null; exit 0' TERM INT
for CAM in $(python3 -c "import gravador; print(' '.join(gravador.cams()))"); do
  mkdir -p "ui/rec/$CAM"
  ( while true; do
      ffmpeg -nostdin -loglevel error -rtsp_transport tcp -i "rtsp://127.0.0.1:8554/${CAM}${SUF}" \
        -an -c copy -f segment -segment_time "$SEG" -reset_timestamps 1 -strftime 1 -segment_format_options movflags=+faststart \
        "ui/rec/$CAM/%Y%m%d_%H%M%S.mp4"
      echo "[$CAM] captura caiu; tentando de novo em 3s"; sleep 3
    done ) &
  PIDS+=($!)
  echo "gravando $CAM"
done
python3 -u gravador.py &
PIDS+=($!)
wait
