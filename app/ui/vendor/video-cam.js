// video-cam: custom element baseado no VideoRTC do go2rtc, sem overlay próprio.
// Emite CustomEvent('camstate', {detail:{state, mode}}) para o React desenhar a UI.
//   state: 'connecting' | 'live' | 'error' | 'offline'
//   mode:  'RTC' | 'MSE' | 'MJPEG' | '' 
import { VideoRTC } from './video-rtc.js';

class VideoCam extends VideoRTC {
  oninit() {
    // aba escondida / janela minimizada: desliga o vídeo (volta sozinho ao mostrar a aba).
    // Assim um painel esquecido aberto não fica decodificando 4 câmeras à toa.
    this.visibilityCheck = true;        // precisa ser antes do super (que registra o listener)
    super.oninit();
    this.video.controls = false;        // sem controles nativos; a UI cuida disso
    this.video.muted = true;
    this.video.style.objectFit = 'cover';
    this.video.style.background = '#000';
  }
  _emit(state, mode) {
    this.dispatchEvent(new CustomEvent('camstate', { detail: { state, mode: mode || '' } }));
  }
  onconnect() {
    const r = super.onconnect();
    if (r) this._emit('connecting');
    return r;
  }
  ondisconnect() {
    super.ondisconnect();
    this._emit('offline');
  }
  onclose() {
    this._emit('connecting');           // o VideoRTC tenta reconectar sozinho
    return super.onclose();
  }
  onopen() {
    const r = super.onopen();
    this.onmessage['camstate'] = msg => {
      if (msg.type === 'error') this._emit('error', '');
      else if (['mse','hls','mp4','mjpeg'].includes(msg.type)) this._emit('live', msg.type.toUpperCase());
    };
    return r;
  }
  onpcvideo(ev) {
    super.onpcvideo(ev);
    if (this.pcState !== WebSocket.CLOSED) this._emit('live', 'RTC');
  }
  // fecha ws/pc imediatamente (usado pelo React ao desmontar/trocar qualidade)
  destroy() { try { this.ondisconnect(); } catch (e) {} }
}
customElements.define('video-cam', VideoCam);
