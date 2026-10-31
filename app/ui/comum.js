// comum.js — peças compartilhadas do painel: chamadas à API, nome de quem usa, janela modal e formatos.
const { useState, useEffect } = React;
const html = htm.bind(React.createElement);

export async function api(url, opts = {}) {
  const o = { cache: 'no-store', ...opts };
  if (o.json !== undefined) { o.method = o.method || 'POST'; o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(o.json); delete o.json; }
  const r = await fetch(url, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || j.msg || ('HTTP ' + r.status));
  return j;
}

export const two = n => String(n).padStart(2, '0');
export const hhmmss = ep => { const d = new Date(ep * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
export const ddmm = ep => { const d = new Date(ep * 1000); return `${two(d.getDate())}/${two(d.getMonth() + 1)}`; };
export const dataHora = ep => ddmm(ep) + ' ' + hhmmss(ep);
export const brl = v => 'R$ ' + (v || 0).toFixed(2).replace('.', ',');
export const isoDia = ep => { const d = new Date(ep * 1000); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
// "HH:MM:SS" no mesmo dia de ref -> epoch
export function horaParaEpoch(txt, ref) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((txt || '').trim());
  if (!m) return null;
  const d = new Date(ref * 1000); d.setHours(+m[1], +m[2], +(m[3] || 0), 0);
  return d.getTime() / 1000;
}

// nome de quem está usando o painel (fica salvo neste navegador)
const AKEY = 'mercadinho_autor';
export function lerAutor() { try { return localStorage.getItem(AKEY) || ''; } catch { return ''; } }
export function salvarAutor(n) { try { localStorage.setItem(AKEY, n); } catch {} }

export const STATUS_COR = { aberta: '#fbbf24', analisando: '#4ea1ff', confirmada: '#f0506e', descartada: '#8798ad', resolvida: '#36d399' };
export const STATUS_ROT = { aberta: 'Aberta', analisando: 'Em análise', confirmada: 'Furto confirmado', descartada: 'Descartada', resolvida: 'Resolvida' };

export function Modal({ titulo, onClose, children, largura }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  return html`<div class="md-fundo" onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="md-caixa" style=${{ maxWidth: (largura || 460) + 'px' }}>
      <div class="md-topo"><b>${titulo}</b><button class="iconbtn" onClick=${onClose} title="Fechar">✕</button></div>
      <div class="md-corpo">${children}</div>
    </div>
  </div>`;
}

// Escolha de câmeras (checkboxes)
export function EscolhaCameras({ cameras, nameOf, sel, onChange }) {
  const tog = id => onChange(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  return html`<div class="md-cams">
    ${cameras.map(c => html`<label key=${c.id} class=${'md-cam' + (sel.includes(c.id) ? ' on' : '')}>
      <input type="checkbox" checked=${sel.includes(c.id)} onChange=${() => tog(c.id)} />${nameOf(c)}</label>`)}
  </div>`;
}

// Acompanha um clipe sendo gerado (consulta a cada 1,5s)
export function useClipe(id) {
  const [c, setC] = useState(null);
  useEffect(() => {
    if (!id) { setC(null); return; }
    let vivo = true, timer;
    const ver = async () => {
      try { const m = await api('/api/clipes/' + id + '?_=' + Date.now()); if (!vivo) return; setC(m);
        if (m.status === 'na fila' || m.status === 'gerando') timer = setTimeout(ver, 1500); }
      catch (e) { if (vivo) setC({ status: 'erro', erro: e.message }); }
    };
    ver();
    return () => { vivo = false; clearTimeout(timer); };
  }, [id]);
  return c;
}

export function nomeArquivoClipe(c) {
  const d = new Date(c.t0 * 1000);
  return `clipe_${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}h${two(d.getMinutes())}m${two(d.getSeconds())}s.mp4`;
}

export function EstadoClipe({ clipe, compacto }) {
  if (!clipe) return null;
  if (clipe.status === 'pronto')
    return html`<div class="cl-pronto">
      ${compacto ? null : html`<video src=${clipe.arquivo} controls playsinline preload="metadata" class="cl-video"></video>`}
      <a class="vd-primary" href=${clipe.arquivo} download=${nomeArquivoClipe(clipe)}>⬇ Baixar clipe (${(clipe.tamanho / 1e6).toFixed(1)} MB)</a>
    </div>`;
  if (clipe.status === 'erro') return html`<div class="vd-err">Clipe não gerado: ${clipe.erro}</div>`;
  return html`<div class="cl-prog"><div class="cl-barra"><div style=${{ width: (clipe.progresso || 0) + '%' }}></div></div>
    <span>${clipe.status === 'na fila' ? 'Na fila…' : `Gerando clipe… ${clipe.progresso || 0}%`}</span></div>`;
}
