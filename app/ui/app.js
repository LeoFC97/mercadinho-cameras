import './vendor/video-cam.js?v=2';
import { ReviewView } from './review.js';
import { DiskView } from './disk.js';
import { VendasPanel } from './vendas.js';
import { OcorrenciasView } from './ocorrencias.js';
import { IAView } from './ia.js';
import { PrateleirasView } from './prateleiras.js';
import { DashboardView } from './dashboard.js';
import { EstoqueView } from './estoque.js';

const { useState, useEffect, useRef, useCallback } = React;
const html = htm.bind(React.createElement);

const CFG = window.APP_CONFIG || { go2rtc: 'auto', cameras: [] };
// 'auto' = mesmo host que serviu o painel (localhost, IP da loja ou nome Tailscale), porta 1984
const G = (CFG.go2rtc && CFG.go2rtc !== 'auto' ? CFG.go2rtc : `${location.protocol}//${location.hostname}:1984`).replace(/\/$/, '');
const CAMERAS = CFG.cameras || [];

/* ---------- ícones ---------- */
const I = {
  expand: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`,
  grid: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  cam: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  full: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`,
  ext: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>`,
  history: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>`,
  edit: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  box: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`,
  bi: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15v2M11 10v7M15 12v5M19 6v11"/></svg>`,
  ia: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>`,
  shelf: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18M21 3v18M3 9h18M3 15h18"/><path d="M6 6.5h3M12 12.5h4M7 18.5h2"/></svg>`,
  flag: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/></svg>`,
  sales: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`,
  disk: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  off: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2m4.5-3h5L17 6h4a2 2 0 0 1 2 2v9"/></svg>`,
};

/* ---------- nomes persistidos ---------- */
const NKEY = 'mercadinho_cam_names';
function loadNames() { try { return JSON.parse(localStorage.getItem(NKEY) || '{}'); } catch { return {}; } }
function saveNames(n) { try { localStorage.setItem(NKEY, JSON.stringify(n)); } catch {} }

/* ---------- relógio ---------- */
function useClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setT(new Date()), 1000); return () => clearInterval(id); }, []);
  return t;
}
const two = n => String(n).padStart(2, '0');
const fmtClock = d => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/* ---------- vídeo (custom element gerenciado imperativamente) ---------- */
function CameraVideo({ camId, quality, onState }) {
  const wrap = useRef(null);
  useEffect(() => {
    const el = document.createElement('video-cam');
    el.background = false;
    el.mode = 'webrtc,mse';
    const sid = quality === 'sub' ? camId + '_sub' : camId;
    const handler = e => onState(e.detail);
    el.addEventListener('camstate', handler);
    el.src = G + '/api/ws?src=' + encodeURIComponent(sid);
    wrap.current.appendChild(el);
    return () => {
      el.removeEventListener('camstate', handler);
      if (el.destroy) el.destroy();
      el.remove();
    };
  }, [camId, quality]);
  return html`<div class="vwrap" ref=${wrap} style=${{ position: 'absolute', inset: 0 }}></div>`;
}

/* ---------- badge de status ---------- */
const LABELS = { connecting: 'conectando', live: 'ao vivo', error: 'erro', offline: 'offline' };
function Badge({ state, mode }) {
  return html`<div class=${'badge ' + state}>
    <span class="sdot"></span>
    <span>${LABELS[state] || state}</span>
    ${state === 'live' && mode ? html`<span class="mode">${mode}</span>` : null}
  </div>`;
}

/* ---------- tile de câmera ---------- */
function Tile({ cam, quality, name, onRename, focused, onFocus, onToast, idx, onStateReport }) {
  const [st, setSt] = useState({ state: 'connecting', mode: '' });
  const handleState = (d) => { setSt(d); onStateReport && onStateReport(d); };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const tileRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => setDraft(name), [name]);
  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [editing]);

  const commit = () => { const v = draft.trim() || name; onRename(cam.id, v); setEditing(false); };

  const snapshot = async (e) => {
    e.stopPropagation();
    const url = G + '/api/frame.jpeg?src=' + encodeURIComponent(cam.id);
    const fname = name.replace(/[^\w-]+/g, '_') + '_' + fmtClock(new Date()).replace(/:/g, '') + '.jpg';
    try {
      const r = await fetch(url); const b = await r.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      onToast('Snapshot salvo: ' + fname);
    } catch { window.open(url, '_blank'); onToast('Snapshot aberto em nova aba'); }
  };
  const fsTile = (e) => { e.stopPropagation(); const n = tileRef.current; if (n.requestFullscreen) n.requestFullscreen(); };
  const openGo2rtc = (e) => { e.stopPropagation(); window.open(G + '/stream.html?src=' + encodeURIComponent(cam.id), '_blank'); };

  return html`
    <div class=${'tile' + (focused ? ' focused' : '')} ref=${tileRef} onClick=${() => onFocus(cam.id)}>
      <${CameraVideo} camId=${cam.id} quality=${quality} onState=${handleState} />
      ${st.state === 'connecting' ? html`<div class="offbox"><div class="spin"></div><span>conectando…</span></div>` : null}
      ${st.state === 'offline' || st.state === 'error' ? html`<div class="offbox">${I.off}<span>sem sinal</span></div>` : null}
      <div class="sheen"></div>
      <${Badge} state=${st.state} mode=${st.mode} />
      <div class="tools">
        <button title="Ampliar" onClick=${(e) => { e.stopPropagation(); onFocus(cam.id, true); }}>${I.expand}</button>
        <button title="Renomear" onClick=${(e) => { e.stopPropagation(); setEditing(true); }}>${I.edit}</button>
        <button title="Foto" onClick=${snapshot}>${I.cam}</button>
        <button title="Abrir no go2rtc" onClick=${openGo2rtc}>${I.ext}</button>
        <button title="Tela cheia" onClick=${fsTile}>${I.full}</button>
      </div>
      <div class="cap">
        ${idx != null ? html`<span style=${{opacity:.65,fontSize:'11px',fontWeight:700}}>${idx}</span>` : null}
        ${editing
          ? html`<span class="name"><input ref=${inputRef} value=${draft}
              onClick=${e => e.stopPropagation()}
              onChange=${e => setDraft(e.target.value)}
              onKeyDown=${e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
              onBlur=${commit} /></span>`
          : html`<span class="name" title="Clique duplo para renomear" style=${{pointerEvents:'auto'}}
              onClick=${e => e.stopPropagation()}
              onDblClick=${e => { e.stopPropagation(); setEditing(true); }}>${name}</span>`}
        <span class="ts">${cam.ip || ''}</span>
      </div>
    </div>`;
}

/* ---------- app ---------- */
function App() {
  const [names, setNames] = useState(loadNames);
  const [cols, setCols] = useState('auto');          // 'auto' | 1 | 2 | 3
  const [view, setView] = useState('grid');          // 'grid' | 'focus'
  const [focusId, setFocusId] = useState(CAMERAS[0]?.id);
  // 'auto' (padrão): HD só na câmera grande do modo Foco; no mosaico, stream leve (bem menos trabalho
  // para quem decodifica e menos internet). 'main' = HD em tudo, 'sub' = leve em tudo.
  const [quality, setQualityRaw] = useState(() => { try { return localStorage.getItem('mercadinho_qualidade') || 'auto'; } catch { return 'auto'; } });
  const setQuality = (q) => { setQualityRaw(q); try { localStorage.setItem('mercadinho_qualidade', q); } catch {} };
  const [mode, setMode] = useState('live');          // 'live' | 'review' | 'disk'
  const [toast, setToast] = useState('');
  const [online, setOnline] = useState({});
  const [vendasOpen, setVendasOpen] = useState(false);
  const [vendasNonce, setVendasNonce] = useState(0);
  const [jump, setJump] = useState(null);   // {t, nonce}: Revisão vai para esse horário
  const [ocAbrir, setOcAbrir] = useState(null);
  const [ocAbertas, setOcAbertas] = useState(0);
  useEffect(() => {
    const ver = () => fetch('/api/ocorrencias?_=' + Date.now()).then(r => r.json())
      .then(j => setOcAbertas((j.ocorrencias || []).filter(o => o.status === 'aberta' || o.status === 'analisando').length)).catch(() => {});
    ver(); const id = setInterval(ver, 30000); return () => clearInterval(id);
  }, [mode]);
  const irRevisao = (t) => { setJump({ t, nonce: Date.now() }); setMode('review'); };
  const abrirOcorrencia = (id) => { setOcAbrir(id); setMode('ocorrencias'); };
  const abrirVendas = () => { if (vendasOpen) { setVendasOpen(false); return; } setVendasOpen(true); setVendasNonce(n => n + 1); };
  const verNasCameras = (t) => {
    setJump({ t: t - 20, nonce: Date.now() });
    setMode('review');
    if (window.innerWidth < 900) setVendasOpen(false);
  };
  const clock = useClock();
  const rootRef = useRef(null);

  const nameOf = (c) => names[c.id] || c.name || c.id;
  const rename = (id, v) => { const n = { ...names, [id]: v }; setNames(n); saveNames(n); };
  const showToast = useCallback((m) => { setToast(m); clearTimeout(window.__tt); window.__tt = setTimeout(() => setToast(''), 2600); }, []);

  const focusCam = (id, force) => { setFocusId(id); if (force || view === 'grid') setView('focus'); };
  const toGrid = () => setView('grid');
  const fsAll = () => { const n = rootRef.current; if (!document.fullscreenElement) n.requestFullscreen?.(); else document.exitFullscreen?.(); };

  useEffect(() => {
    const onKey = (e) => {
      if (mode !== 'live' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key >= '1' && e.key <= '9') { const c = CAMERAS[+e.key - 1]; if (c) focusCam(c.id, true); }
      else if (e.key === '0' || e.key === 'Escape') toGrid();
      else if (e.key.toLowerCase() === 'f') fsAll();
      else if (e.key.toLowerCase() === 'g') toGrid();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, mode]);

  const colClass = cols === 'auto'
    ? (CAMERAS.length <= 1 ? 'cols-1' : CAMERAS.length <= 4 ? 'cols-2' : 'cols-3')
    : 'cols-' + cols;

  const onlineCount = Object.values(online).filter(s => s === 'live').length;
  const setCamState = (id) => (d) => setOnline(o => (o[id] === d.state ? o : { ...o, [id]: d.state }));

  // tiles compartilhados (um por câmera) — recriados só quando muda qualidade
  const tileFor = (cam, opts = {}) => html`<${Tile}
      key=${(opts.where||'g') + '_' + cam.id} cam=${cam}
      quality=${quality !== 'auto' ? quality : (opts.where === 'main' || CAMERAS.length === 1 ? 'main' : 'sub')} name=${nameOf(cam)}
      onRename=${rename} onFocus=${focusCam} onToast=${showToast}
      focused=${opts.focused} idx=${opts.idx} onStateReport=${setCamState(cam.id)} />`;

  const vendasBtn = html`<button class=${'iconbtn' + (vendasOpen ? ' on' : '')} title="Últimas vendas do market4u" onClick=${abrirVendas} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.sales}<span style=${{fontSize:'12.5px',fontWeight:600}}>Vendas</span></button>`;
  const ocBtn = html`<button class=${'iconbtn' + (mode === 'ocorrencias' ? ' on' : '')} title="Ocorrências marcadas e clipes" onClick=${() => { setOcAbrir(null); setMode('ocorrencias'); }} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.flag}<span style=${{fontSize:'12.5px',fontWeight:600}}>Ocorrências</span>${ocAbertas ? html`<span class="oc-badge">${ocAbertas}</span>` : null}</button>`;
  const iaBtn = html`<button class=${'iconbtn' + (mode === 'ia' ? ' on' : '')} title="Inteligência Artificial — fotos e marcações dos produtos" onClick=${() => setMode('ia')} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.ia}<span style=${{fontSize:'12.5px',fontWeight:600}}>IA</span></button>`;
  const pratBtn = html`<button class=${'iconbtn' + (mode === 'prateleiras' ? ' on' : '')} title="Prateleiras — zonas de interesse, itens e o que saiu" onClick=${() => setMode('prateleiras')} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.shelf}<span style=${{fontSize:'12.5px',fontWeight:600}}>Prateleiras</span></button>`;
  const dbBtn = html`<button class=${'iconbtn' + (mode === 'dashboard' ? ' on' : '')} title="Dashboard de vendas — indicadores, gráficos e análises" onClick=${() => setMode('dashboard')} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.bi}<span style=${{fontSize:'12.5px',fontWeight:600}}>Dashboard</span></button>`;
  const estBtn = html`<button class=${'iconbtn' + (mode === 'estoque' ? ' on' : '')} title="Estoque do CD e da loja, e lista de compras" onClick=${() => setMode('estoque')} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.box}<span style=${{fontSize:'12.5px',fontWeight:600}}>Estoque</span></button>`;
  const shell = (main) => html`<div class="shell">
      <div class="shell-main">${main}</div>
      ${vendasOpen ? html`<${VendasPanel} autoBuscar=${vendasNonce} onClose=${() => setVendasOpen(false)} onVerCameras=${verNasCameras} />` : null}
    </div>`;

  if (mode === 'review')
    return shell(html`<${ReviewView} cameras=${CAMERAS} nameOf=${nameOf} go2rtc=${G} onExit=${() => setMode('live')} jump=${jump} extraButtons=${html`${estBtn}${dbBtn}${pratBtn}${iaBtn}${ocBtn}${vendasBtn}`} onAbrirOcorrencia=${abrirOcorrencia} />`);
  if (mode === 'prateleiras')
    return shell(html`<div style=${{height:'100%'}}>
      <${PrateleirasView} cameras=${CAMERAS} nameOf=${nameOf} onExit=${() => setMode('live')} onVer=${irRevisao}
        extraButtons=${html`${dbBtn}${iaBtn}${ocBtn}${vendasBtn}`} onToast=${showToast} />
      <div class=${'toast' + (toast ? ' show' : '')}>${toast}</div>
    </div>`);
  if (mode === 'ia')
    return shell(html`<div style=${{height:'100%'}}>
      <${IAView} cameras=${CAMERAS} nameOf=${nameOf} go2rtc=${G} onExit=${() => setMode('live')} extraButtons=${html`${dbBtn}${pratBtn}${ocBtn}${vendasBtn}`} onToast=${showToast} />
      <div class=${'toast' + (toast ? ' show' : '')}>${toast}</div>
    </div>`);
  if (mode === 'ocorrencias')
    return shell(html`<div style=${{height:'100%'}}>
      <${OcorrenciasView} cameras=${CAMERAS} nameOf=${nameOf} onExit=${() => setMode('live')} onVer=${irRevisao}
        abrirId=${ocAbrir} extraButtons=${html`${dbBtn}${iaBtn}${vendasBtn}`} onToast=${showToast} />
      <div class=${'toast' + (toast ? ' show' : '')}>${toast}</div>
    </div>`);
  if (mode === 'estoque')
    return shell(html`<div style=${{height:'100%'}}>
      <${EstoqueView} onExit=${() => setMode('live')} extraButtons=${html`${dbBtn}${vendasBtn}`} onToast=${showToast}
        onAbrirVendas=${() => { setVendasOpen(true); setVendasNonce(n => n + 1); }} />
      <div class=${'toast' + (toast ? ' show' : '')}>${toast}</div>
    </div>`);
  if (mode === 'dashboard')
    return shell(html`<${DashboardView} onExit=${() => setMode('live')} extraButtons=${html`${estBtn}${ocBtn}${vendasBtn}`}
      onAbrirVendas=${() => { setVendasOpen(true); setVendasNonce(n => n + 1); }} />`);
  if (mode === 'disk')
    return shell(html`<div style=${{height:'100%'}}>
      <${DiskView} cameras=${CAMERAS} nameOf=${nameOf} onExit=${() => setMode('live')} onToast=${showToast} />
      <div class=${'toast' + (toast ? ' show' : '')}>${toast}</div>
    </div>`);

  return shell(html`
    <div ref=${rootRef} style=${{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div class="topbar">
        <div class="brand">
          <span class="dot"></span>
          <h1>Câmeras · Mercadinho</h1>
          <small>${CAMERAS.length} câmeras</small>
        </div>
        <div class="spacer"></div>
        <div class="stat">online <b>${onlineCount}/${CAMERAS.length}</b></div>
        <div class="clock">${fmtClock(clock)}</div>
        <div class="seg">
          <button class=${view === 'grid' && cols === 'auto' ? 'on' : ''} onClick=${() => { setView('grid'); setCols('auto'); }}>${I.grid} Auto</button>
          <button class=${view === 'grid' && cols === 2 ? 'on' : ''} onClick=${() => { setView('grid'); setCols(2); }}>2×2</button>
          <button class=${view === 'grid' && cols === 3 ? 'on' : ''} onClick=${() => { setView('grid'); setCols(3); }}>3×3</button>
          <button class=${view === 'focus' ? 'on' : ''} onClick=${() => setView('focus')}>${I.expand} Foco</button>
        </div>
        <div class="seg">
          <button class=${quality === 'auto' ? 'on' : ''} title="HD só na câmera ampliada; mosaico leve (recomendado)" onClick=${() => setQuality('auto')}>Auto</button>
          <button class=${quality === 'main' ? 'on' : ''} onClick=${() => setQuality('main')}>HD</button>
          <button class=${quality === 'sub' ? 'on' : ''} onClick=${() => setQuality('sub')}>Econ</button>
        </div>
        <button class="iconbtn" title="Revisão — voltar no tempo" onClick=${() => setMode('review')} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.history}<span style=${{fontSize:'12.5px',fontWeight:600}}>Revisão</span></button>
        ${pratBtn}
        ${iaBtn}
        ${ocBtn}
        ${dbBtn}
        ${estBtn}
        ${vendasBtn}
        <button class="iconbtn" title="Disco — espaço e limpeza das gravações" onClick=${() => setMode('disk')} style=${{width:'auto',padding:'0 12px',gap:'7px'}}>${I.disk}<span style=${{fontSize:'12.5px',fontWeight:600}}>Disco</span></button>
        <button class="iconbtn" title="Tela cheia (F)" onClick=${fsAll}>${I.full}</button>
      </div>

      <div class="stage">
        ${view === 'grid'
          ? html`<div class=${'grid ' + colClass}>
              ${CAMERAS.map((c, i) => tileFor(c, { idx: i + 1, where: 'g' }))}
            </div>`
          : html`<div class="focus">
              <div class="main">
                ${(() => { const c = CAMERAS.find(x => x.id === focusId) || CAMERAS[0]; return c ? tileFor(c, { focused: true, where: 'main' }) : null; })()}
              </div>
              <div class="strip">
                ${CAMERAS.map((c, i) => tileFor(c, { idx: i + 1, focused: c.id === focusId, where: 'strip' }))}
              </div>
            </div>`}
      </div>

      <div class=${'toast' + (toast ? ' show' : '')}>${toast}</div>
    </div>`);
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
