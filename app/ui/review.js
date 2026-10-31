// review.js — modo Revisão: as 4 câmeras andando juntas no passado.
// Lê os segmentos gravados (/rec) e sincroniza o playback por horário (epoch).
import { api, Modal, EscolhaCameras, EstadoClipe, useClipe, lerAutor, salvarAutor, horaParaEpoch, brl, STATUS_COR, STATUS_ROT } from './comum.js';
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  return r.json();
}
const two = n => String(n).padStart(2, '0');
const hhmmss = ep => { const d = new Date(ep * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const hhmm = ep => { const d = new Date(ep * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

// acha o índice do segmento que cobre t (lista ordenada por .t); -1 se não há
function segAt(list, t) {
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans >= 0 && t < list[ans].t + list[ans].d + 0.25) return ans;
  return -1;
}

const MOTION_TH = 1.6;

export function ReviewView({ cameras, nameOf, go2rtc, onExit, jump, extraButtons, onAbrirOcorrencia }) {
  const [manifest, setManifest] = useState(null);
  const [day, setDay] = useState(null);
  const [index, setIndex] = useState({});     // camId -> [ {t,d,m,f} ] ordenado
  const [range, setRange] = useState(null);   // {start,end} epoch do dia com gravação
  const [dispT, setDispT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [err, setErr] = useState('');
  const [aviso, setAviso] = useState('');
  const pendingJump = useRef(null);
  const [analise, setAnalise] = useState(null);     // movimento x vendas do dia
  const [ocorrs, setOcorrs] = useState([]);          // ocorrências do dia
  const [modal, setModal] = useState(null);          // 'marcar' | 'clipe' | null
  const [listaSusp, setListaSusp] = useState(false);
  const carregarAnalise = useCallback(async (d) => {
    if (!d) return;
    try { const a = await api('/api/analise?dia=' + d + '&_=' + Date.now()); setAnalise(a); } catch { setAnalise(null); }
  }, []);
  const carregarOcorrs = useCallback(async (d) => {
    try { const r = await api('/api/ocorrencias?_=' + Date.now());
      setOcorrs((r.ocorrencias || []).filter(o => { const x = new Date(o.t * 1000); return `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}` === d; }));
    } catch {}
  }, []);
  useEffect(() => {
    if (!day) return;
    setAnalise(null); carregarAnalise(day); carregarOcorrs(day);
    const id = setInterval(() => carregarAnalise(day), 120000);   // hoje: vendas novas entram sozinhas
    return () => clearInterval(id);
  }, [day]);   // horário pedido de fora (ex.: "ver nas câmeras" de uma venda)
  useEffect(() => { if (!aviso) return; const id = setTimeout(() => setAviso(''), 4500); return () => clearTimeout(id); }, [aviso]);

  const tRef = useRef(0), playingRef = useRef(false), speedRef = useRef(1);
  const vids = useRef({});       // camId -> <video> ATIVO (o que aparece)
  // Dois <video> por câmera: enquanto um toca, o outro já carrega o próximo trecho de 12s.
  // Na virada é só trocar qual aparece — sem esperar carregar (era o que dava o "travadinho").
  const pares = useRef({});      // camId -> [videoA, videoB]
  const ativo = useRef({});      // camId -> 0 | 1
  const pre = useRef({});        // camId -> arquivo já carregando no vídeo reserva
  const reserva = (id) => { const p = pares.current[id]; return p ? p[1 - (ativo.current[id] || 0)] : null; };
  const cur = useRef({});        // camId -> arquivo carregado
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; for (const par of Object.values(pares.current)) for (const v of par || []) if (v) v.playbackRate = Math.min(speed, 4); }, [speed]);

  // carrega manifest
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await getJSON('/rec/manifest.json?_=' + Date.now());
        if (!alive) return;
        setManifest(m);
        if (m.days && m.days.length) setDay(d => d || m.days[m.days.length - 1]);
        else setErr('Sem gravações ainda. Inicie o gravador (5-gravador.command) e aguarde ~1 min.');
      } catch (e) { if (alive) setErr('Sem gravações ainda. Inicie o gravador (5-gravador.command).'); }
    })();
    return () => { alive = false; };
  }, []);

  // carrega índices do dia selecionado
  useEffect(() => {
    if (!day) return;
    let alive = true;
    (async () => {
      const idx = {};
      for (const c of cameras) {
        try {
          const raw = await getJSON(`/rec/${c.id}/${day}.json?_=` + Date.now());
          idx[c.id] = Object.entries(raw).map(([f, v]) => ({ f, ...v })).sort((a, b) => a.t - b.t);
        } catch { idx[c.id] = []; }
      }
      if (!alive) return;
      setIndex(idx);
      let s = Infinity, e = -Infinity;
      for (const c of cameras) for (const seg of (idx[c.id] || [])) { s = Math.min(s, seg.t); e = Math.max(e, seg.t + seg.d); }
      if (s === Infinity) { setRange(null); return; }
      setRange({ start: s, end: e, day });
      tRef.current = s; setDispT(s);
    })();
    return () => { alive = false; };
  }, [day, cameras]);

  // garante o segmento certo em cada <video> para o tempo t.
  // isMaster: a câmera que dita o relógio nunca é "corrigida" contra ele (senão relógio e vídeo
  // ficam se puxando — era o vai-e-volta); as outras corrigem deriva com folga e intervalo mínimo.
  const lastFix = useRef({});    // camId -> ms da última correção por seek
  const syncCam = (camId, t, play, isMaster) => {
    const v = vids.current[camId]; if (!v) return false;
    const list = index[camId] || [];
    const i = segAt(list, t);
    if (i < 0) { // sem gravação nesse instante
      if (cur.current[camId] !== null) { cur.current[camId] = null; v.removeAttribute('src'); v.load(); }
      return false;
    }
    const seg = list[i];
    const want = seg.f;
    const sp = reserva(camId);
    if (cur.current[camId] !== want && sp && pre.current[camId] === want && sp.readyState >= 2) {
      // próximo trecho já carregado no reserva: troca na hora
      ativo.current[camId] = 1 - (ativo.current[camId] || 0);
      vids.current[camId] = sp;
      cur.current[camId] = want; pre.current[camId] = null;
      const dur = isFinite(sp.duration) ? sp.duration : seg.d;
      const off = Math.max(0, Math.min(dur - 0.05, tRef.current - seg.t));
      try { if (Math.abs(sp.currentTime - off) > 0.25) sp.currentTime = off; sp.playbackRate = Math.min(speedRef.current, 4); } catch {}
      if (playingRef.current) sp.play().catch(() => {});
      sp.style.visibility = 'visible'; v.style.visibility = 'hidden';
      v.pause();
      lastFix.current[camId] = performance.now();
      return true;
    }
    if (cur.current[camId] !== want) {
      cur.current[camId] = want;
      v.src = `/rec/${camId}/${want}`;
      v.load();
      const onmeta = () => {
        v.removeEventListener('loadedmetadata', onmeta);
        if (cur.current[camId] !== want) return;            // já trocou de novo
        // posição calculada AGORA (o carregamento pode ter demorado), não na hora do pedido
        const dur = isFinite(v.duration) ? v.duration : seg.d;
        const off = Math.max(0, Math.min(dur - 0.05, tRef.current - seg.t));
        try { v.currentTime = off; v.playbackRate = Math.min(speedRef.current, 4); } catch {}
        if (playingRef.current) v.play().catch(() => {});
      };
      v.addEventListener('loadedmetadata', onmeta);
      lastFix.current[camId] = performance.now();
      return true;
    }
    const base = Math.min(speedRef.current, 4);
    // (só corrige quem já está tocando: pular um vídeo que ainda está carregando faz ele recomeçar e nunca chegar)
    if (!isMaster && v.readyState >= 3 && !v.seeking) {
      const drift = v.currentTime - (t - seg.t);            // + adiantado, − atrasado
      const now = performance.now();
      const lim = 0.8 * Math.max(1, speedRef.current);
      if (Math.abs(drift) > lim && now - (lastFix.current[camId] || 0) > 1500) {
        lastFix.current[camId] = now;                       // longe demais: pula (no máx. 1x a cada 1,5s)
        try { v.currentTime = Math.max(0, t - seg.t); } catch {}
        v.playbackRate = base;
      } else if (play && Math.abs(drift) > 0.12) {
        v.playbackRate = base * (drift > 0 ? 0.9 : 1.1);    // perto: acerta acelerando/freando de leve
      } else if (v.playbackRate !== base) {
        v.playbackRate = base;
      }
    }
    if (play && v.paused && !v.ended) v.play().catch(() => {});
    if (!play && !v.paused) v.pause();
    // pré-carrega o próximo trecho no vídeo reserva (depois que o atual já está tocando bem)
    const nx = list[i + 1];
    let folga = 0;
    try { for (let k = 0; k < v.buffered.length; k++) if (v.buffered.start(k) <= v.currentTime + 0.1) folga = Math.max(folga, v.buffered.end(k) - v.currentTime); } catch {}
    const resta = (isFinite(v.duration) ? v.duration : seg.d) - v.currentTime;
    if (sp && nx && v.readyState >= 3 && folga >= Math.min(4, resta - 0.2) && pre.current[camId] !== nx.f && nx.t - (seg.t + seg.d) < 3) {
      pre.current[camId] = nx.f;
      sp.preload = 'auto';
      sp.src = `/rec/${camId}/${nx.f}`;
      sp.load();
    }
    return true;
  };

  // câmera "mestre": fica a mesma enquanto ela tiver gravação em t; senão, a primeira que tiver
  const masterRef = useRef(null);
  // foco: uma câmera grande; as outras param de baixar (ajuda muito em internet fraca)
  const [foco, setFoco] = useState(null);
  const focoRef = useRef(null);
  useEffect(() => { focoRef.current = foco; masterRef.current = null;
    // as outras câmeras param de baixar de verdade (sem src = sem download)
    for (const c of cameras) if (foco && c.id !== foco) {
      for (const v of pares.current[c.id] || []) if (v && v.getAttribute('src')) { v.pause(); v.removeAttribute('src'); v.load(); }
      cur.current[c.id] = undefined; pre.current[c.id] = null;
    } }, [foco]);
  const ativas = () => focoRef.current ? cameras.filter(c => c.id === focoRef.current) : cameras;
  const masterAt = (t) => {
    const m = masterRef.current;
    if (m && segAt(index[m] || [], t) >= 0 && ativas().some(c => c.id === m)) return m;
    for (const c of ativas()) { if (segAt(index[c.id] || [], t) >= 0) return c.id; }
    return null;
  };
  const nextSegStart = (t) => {
    let best = Infinity;
    for (const c of ativas()) for (const seg of (index[c.id] || [])) if (seg.t > t + 0.1) best = Math.min(best, seg.t);
    return best === Infinity ? null : best;
  };

  // loop de sincronização (5 Hz)
  const waitSince = useRef(0);   // desde quando o mestre está carregando/travado
  useEffect(() => {
    if (!range) return;
    const id = setInterval(() => {
      let t = tRef.current;
      const play = playingRef.current;
      let mid = null, hold = false;
      if (play) {
        mid = masterAt(t);
        if (mid !== masterRef.current) { masterRef.current = mid; waitSince.current = 0; }
        if (mid) {
          const v = vids.current[mid];
          const list = index[mid]; const i = segAt(list, t);
          const seg = list[i];
          const ready = v && v.readyState >= 2 && !v.seeking && cur.current[mid] === seg.f;
          if (ready) {
            waitSince.current = 0;
            const vt = seg.t + v.currentTime;
            const dur = isFinite(v.duration) ? v.duration : seg.d;
            if (v.ended || v.currentTime >= dur - 0.05) {
              t = Math.max(t, seg.t + Math.max(dur, seg.d) + 0.3);   // fim do arquivo: passa pro próximo
            } else if (vt > t) {
              t = vt;                                // tempo guiado pelo vídeo mestre, nunca para trás
            } else if (t - vt > 1.5) {
              try { v.currentTime = Math.max(0, t - seg.t); } catch {}   // mestre recém-escolhido e atrasado
            }
          } else {
            // carregando/bufferizando: SEGURA o relógio (antes ele seguia andando e depois voltava).
            // Só anda sozinho se o mestre ficar travado demais (arquivo com problema).
            const now = performance.now();
            if (!waitSince.current) waitSince.current = now;
            if (now - waitSince.current > 4000) t = t + 0.2 * speedRef.current;
            else hold = now - waitSince.current > 300;   // as outras esperam junto (não disparam na frente)
          }
          if (t >= range.end - 0.1) { t = range.end; playingRef.current = false; setPlaying(false); }
        } else {
          const ns = nextSegStart(t);              // pula buraco sem gravação
          if (ns) t = ns; else { t = range.end; playingRef.current = false; setPlaying(false); }
        }
        tRef.current = t;
      }
      for (const c of ativas()) syncCam(c.id, tRef.current, playingRef.current && (c.id === mid || !hold), play && c.id === mid);
      setDispT(tRef.current);
    }, 200);
    return () => clearInterval(id);
  }, [range, index, cameras]);

  const seekTo = (t) => {
    const r = range; if (!r) return;
    t = Math.max(r.start, Math.min(r.end, t));
    tRef.current = t; setDispT(t);
    masterRef.current = null; waitSince.current = 0;
    for (const c of ativas()) { lastFix.current[c.id] = 0; syncCam(c.id, t, playingRef.current, false); }
  };
  // pedido externo de horário: troca o dia se precisar e posiciona (quando o índice do dia chegar)
  useEffect(() => { if (jump) pendingJump.current = jump.t; }, [jump && jump.nonce]);
  useEffect(() => {
    const t = pendingJump.current;
    if (t == null || !manifest) return;
    const d = new Date(t * 1000);
    const ds = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    if (!(manifest.days || []).includes(ds)) { pendingJump.current = null; setAviso('Sem gravação no dia ' + ds.split('-').reverse().join('/')); return; }
    if (day !== ds) { setPlaying(false); setDay(ds); return; }
    if (!range || range.day !== ds) return;
    pendingJump.current = null;
    if (t < range.start - 60 || t > range.end + 60) setAviso('Sem gravação perto de ' + hhmmss(t) + ' — mostrando o trecho mais próximo');
    seekTo(t);
    setPlaying(true);
  }, [jump && jump.nonce, manifest, day, range]);

  const togglePlay = () => setPlaying(p => !p);
  const step = (sec) => seekTo(tRef.current + sec);
  const nextMotion = (dir) => {
    // próximo/anterior segmento com movimento em qualquer câmera
    let cand = dir > 0 ? Infinity : -Infinity;
    for (const c of cameras) for (const seg of (index[c.id] || [])) {
      if (seg.m >= MOTION_TH) {
        if (dir > 0 && seg.t > tRef.current + 1) cand = Math.min(cand, seg.t);
        if (dir < 0 && seg.t < tRef.current - 1) cand = Math.max(cand, seg.t);
      }
    }
    if (isFinite(cand)) seekTo(cand);
  };

  const suspeitos = useMemo(() => (analise?.eventos || []).filter(e => e.vendas === 0), [analise]);
  const irSuspeito = (dir) => {
    const t = tRef.current;
    const lst = dir > 0 ? suspeitos.filter(e => e.inicio > t + 1) : suspeitos.filter(e => e.inicio < t - 3).reverse();
    if (lst.length) { seekTo(lst[0].inicio - 5); }
    else setAviso(dir > 0 ? 'Não há mais trechos sem venda depois deste ponto' : 'Não há trechos sem venda antes deste ponto');
  };
  const pausarE = (m) => { setPlaying(false); setModal(m); };
  // fotos para a IA no instante atual (das câmeras visíveis)
  const fotoIA = async () => {
    setPlaying(false);
    const t = tRef.current, cams = ativas().map(c => c.id);
    const venda = (analise?.vendas || []).filter(v => Math.abs(v.t - t) <= 60).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    try {
      const r = await api('/api/ia/capturar', { json: { fonte: 'gravacao', cameras: cams, tempos: [t], autor: lerAutor(),
        venda: venda ? { t: venda.t, total: venda.total, produtos: venda.produtos } : null } });
      setAviso(`${r.imagens.length} foto(s) enviada(s) para a fila da IA (aba IA → Rotular)`);
    } catch (e) { setAviso('Não deu para tirar a foto: ' + e.message); }
  };

  const changeDay = (delta) => {
    if (!manifest || !manifest.days.length) return;
    const i = manifest.days.indexOf(day);
    const ni = Math.max(0, Math.min(manifest.days.length - 1, i + delta));
    setPlaying(false); setDay(manifest.days[ni]);
  };

  // --- render ---
  const I = {
    back: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
    play: html`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
    pause: html`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`,
    prev: html`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12l-9-6z"/></svg>`,
    next: html`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l9 6-9 6z"/></svg>`,
    live: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>`,
  };
  const cols = cameras.length <= 1 ? 'cols-1' : cameras.length <= 4 ? 'cols-2' : 'cols-3';

  return html`
    <div style=${{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div class="topbar">
        <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>${I.live}</button>
        <div class="brand"><h1>Revisão</h1><small>gravações</small></div>
        <div class="seg">
          <button onClick=${() => changeDay(-1)}>◀</button>
          <button class="on" style=${{cursor:'default'}}>${day || '—'}</button>
          <button onClick=${() => changeDay(1)}>▶</button>
        </div>
        <div class="spacer"></div>
        ${extraButtons || null}
        ${manifest && manifest.disk ? html`<div class="stat">disco <b>${manifest.disk.used_gb}</b>/${manifest.disk.cap_gb} GB</div>` : null}
        <div class="clock">${range ? hhmmss(dispT) : '--:--:--'}</div>
      </div>

      <div class="stage">
        ${aviso ? html`<div class="vd-aviso">${aviso}</div>` : null}
        ${err
          ? html`<div class="offbox" style=${{position:'static',height:'100%'}}><span>${err}</span></div>`
          : html`<div class=${'grid ' + (foco ? 'cols-1' : cols)} style=${{height:'100%'}}>
              ${cameras.map(c => html`
                <div class="tile" key=${c.id} style=${{display: foco && foco !== c.id ? 'none' : ''}} title=${foco ? 'Clique para voltar a ver todas' : 'Clique para ver só esta câmera (mais leve na internet)'}
                     onClick=${() => { const nv = focoRef.current === c.id ? null : c.id; focoRef.current = nv; masterRef.current = null; setFoco(nv); seekTo(tRef.current); }}>
                  ${[0, 1].map(k => html`<video key=${k} muted playsinline preload="auto"
                     ref=${el => { const p = pares.current[c.id] || (pares.current[c.id] = [null, null]); p[k] = el;
                                   if (el && (ativo.current[c.id] || 0) === k) vids.current[c.id] = el;
                                   if (el && el.style.visibility === '') el.style.visibility = k === (ativo.current[c.id] || 0) ? 'visible' : 'hidden'; }}
                     style=${{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',background:'#000'}}></video>`)}
                  ${segAt(index[c.id] || [], dispT) < 0
                    ? html`<div class="offbox"><span>sem gravação</span></div>` : null}
                  <div class="sheen"></div>
                  <div class="cap"><span class="name">${nameOf(c)}</span><span class="ts">${c.ip || ''}</span></div>
                </div>`)}
            </div>`}
      </div>

      ${range ? html`<${Controls}
          range=${range} t=${dispT} playing=${playing} speed=${speed}
          index=${index} cameras=${cameras} analise=${analise} ocorrs=${ocorrs} suspeitos=${suspeitos}
          onSeek=${seekTo} onToggle=${togglePlay} onStep=${step}
          onSpeed=${setSpeed} onMotion=${nextMotion} onSuspeito=${irSuspeito}
          onLista=${() => setListaSusp(v => !v)} onMarcar=${() => pausarE('marcar')} onClipe=${() => pausarE('clipe')} onFotoIA=${fotoIA}
          onOcorrencia=${onAbrirOcorrencia} I=${I} /> ` : null}

      ${listaSusp && analise ? html`<${ListaSuspeitos} analise=${analise} t=${dispT}
          onIr=${(e) => { seekTo(e.inicio - 5); }} onClose=${() => setListaSusp(false)} />` : null}
      ${modal === 'marcar' ? html`<${MarcarModal} t=${tRef.current} cameras=${cameras} nameOf=${nameOf} analise=${analise}
          onClose=${() => setModal(null)} onFeito=${(o) => { setModal(null); carregarOcorrs(day); setAviso('Ocorrência marcada' + (o.clipe ? ' — gerando o clipe' : '')); }} />` : null}
      ${modal === 'clipe' ? html`<${ClipeModal} t=${tRef.current} cameras=${cameras} nameOf=${nameOf} onClose=${() => setModal(null)} />` : null}
    </div>`;
}

// Barra de controles + linha do tempo com mapa de movimento, vendas, trechos sem venda e ocorrências
function Controls({ range, t, playing, speed, index, cameras, analise, ocorrs, suspeitos, onSeek, onToggle, onStep, onSpeed, onMotion,
                    onSuspeito, onLista, onMarcar, onClipe, onFotoIA, onOcorrencia, I }) {
  const barRef = useRef(null);
  const span = Math.max(1, range.end - range.start);
  const pct = ((t - range.start) / span) * 100;
  const pos = (ep) => ((ep - range.start) / span) * 100;

  const onBar = (e) => {
    const r = barRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onSeek(range.start + x * span);
  };
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    if (!drag) return;
    const mv = (e) => onBar(e); const up = () => setDrag(false);
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, [drag]);

  // marcas de hora
  const ticks = [];
  const startH = Math.ceil(range.start / 3600) * 3600;
  for (let tk = startH; tk < range.end; tk += 3600) ticks.push(tk);
  const btxt = { width: 'auto', padding: '0 10px', fontSize: '12px', fontWeight: 600 };
  const evs = analise?.eventos || [];
  const vendas = analise?.vendas || [];

  return html`
    <div style=${{flex:'0 0 auto',padding:'10px 14px 14px',borderTop:'1px solid var(--line)',background:'var(--bg2)'}}>
      <div style=${{display:'flex',alignItems:'center',gap:'8px',marginBottom:'10px',flexWrap:'wrap'}}>
        <button class="iconbtn" title="Movimento anterior" onClick=${() => onMotion(-1)}>${I.prev}</button>
        <button class="iconbtn" style=${{width:'44px'}} title=${playing ? 'Pausar' : 'Reproduzir'} onClick=${onToggle}>${playing ? I.pause : I.play}</button>
        <button class="iconbtn" title="Próximo movimento" onClick=${() => onMotion(1)}>${I.next}</button>
        <button class="iconbtn" style=${btxt} onClick=${() => onStep(-10)}>−10s</button>
        <button class="iconbtn" style=${btxt} onClick=${() => onStep(10)}>+10s</button>
        <div class="rv-sep"></div>
        <div class="rv-susp" title="Trechos com movimento e nenhuma venda perto (possível furto)">
          <button class="iconbtn" onClick=${() => onSuspeito(-1)} title="Trecho sem venda anterior">◀</button>
          <button class=${'iconbtn rv-susp-n' + (suspeitos.length ? ' alerta' : '')} style=${btxt} onClick=${onLista}>
            ${analise && !analise.vendas_ok ? 'Sem venda: ?' : `Sem venda: ${suspeitos.length}`}</button>
          <button class="iconbtn" onClick=${() => onSuspeito(1)} title="Próximo trecho sem venda">▶</button>
        </div>
        <div class="spacer" style=${{flex:1}}></div>
        <button class="iconbtn rv-acao" style=${btxt} onClick=${onMarcar} title="Marcar uma ocorrência neste horário">🚩 Marcar ocorrência</button>
        <button class="iconbtn rv-acao" style=${btxt} onClick=${onClipe} title="Exportar um trecho como vídeo">🎬 Exportar clipe</button>
        <button class="iconbtn rv-acao" style=${btxt} onClick=${onFotoIA} title="Tirar foto deste instante para treinar a IA (vai para a fila de rotulagem)">📸 IA</button>
        <div class="seg">
          ${[0.5,1,2,4,8].map(s => html`<button class=${speed===s?'on':''} onClick=${() => onSpeed(s)}>${s}×</button>`)}
        </div>
      </div>
      <div ref=${barRef} onMouseDown=${(e)=>{setDrag(true);onBar(e);}}
        style=${{position:'relative',height:'54px',background:'var(--panel)',border:'1px solid var(--line)',borderRadius:'10px 10px 0 0',overflow:'hidden',cursor:'pointer'}}>
        ${cameras.map((c, ci) => {
          const rowH = 54 / cameras.length;
          return (index[c.id] || []).map(seg => {
            const left = pos(seg.t);
            const w = Math.max(0.15, (seg.d / span) * 100);
            const mot = seg.m >= MOTION_TH;
            return html`<div key=${c.id+seg.f} title=${nameAbbrev(c)+' '+hhmmss(seg.t)+(mot?' • movimento':'')}
              style=${{position:'absolute',left:left+'%',width:w+'%',top:(ci*rowH)+'px',height:(rowH-1)+'px',
                       background: mot ? 'var(--accent)' : 'rgba(120,140,170,.28)'}}></div>`;
          });
        })}
        ${ticks.map(tk => { const l = pos(tk); return html`<div key=${tk}
          style=${{position:'absolute',left:l+'%',top:0,bottom:0,width:'1px',background:'rgba(255,255,255,.08)'}}>
          <span style=${{position:'absolute',top:'2px',left:'3px',fontSize:'9px',color:'var(--muted2)'}}>${hhmm(tk)}</span></div>`; })}
        <div style=${{position:'absolute',left:pct+'%',top:0,bottom:0,width:'2px',background:'#fff',boxShadow:'0 0 6px rgba(255,255,255,.8)'}}></div>
      </div>
      <div class="rv-faixa" onMouseDown=${(e)=>{ if (e.target.closest('.rv-flag')) return; setDrag(true); onBar(e); }}>
        ${evs.map((e, i) => html`<div key=${'e'+i} class=${'rv-ev ' + (e.vendas === 0 ? 'sem' : e.vendas ? 'com' : 'nd')}
            title=${`${hhmmss(e.inicio)}–${hhmmss(e.fim)} • ` + (e.vendas === 0 ? 'movimento SEM venda' : e.vendas ? `${e.vendas} venda(s) perto` : 'vendas indisponíveis')}
            style=${{left: pos(e.inicio)+'%', width: Math.max(0.25, ((e.fim-e.inicio)/span)*100)+'%'}}></div>`)}
        ${vendas.map((v, i) => html`<div key=${'v'+i} class="rv-venda" title=${`Venda ${hhmmss(v.t)} • ${brl(v.total)} • ${v.produtos.join(', ')}`}
            style=${{left: pos(v.t)+'%'}}></div>`)}
        ${ocorrs.map(o => html`<div key=${o.id} class="rv-flag" title=${`${hhmmss(o.t)} • ${o.titulo} (${o.autor}) — clique para abrir`}
            style=${{left: pos(o.t)+'%', color: STATUS_COR[o.status] || '#fbbf24'}}
            onClick=${(ev) => { ev.stopPropagation(); onOcorrencia ? onOcorrencia(o.id) : onSeek(o.t); }}>⚑</div>`)}
        <div style=${{position:'absolute',left:pct+'%',top:0,bottom:0,width:'2px',background:'rgba(255,255,255,.7)'}}></div>
      </div>
      <div class="rv-legenda">
        <span><i class="rv-l sem"></i>movimento sem venda</span>
        <span><i class="rv-l com"></i>movimento com venda</span>
        <span><i class="rv-l venda"></i>venda</span>
        <span><b style=${{color:'#fbbf24'}}>⚑</b> ocorrência</span>
        ${analise && !analise.vendas_ok ? html`<span class="rv-nd">vendas indisponíveis${analise.vendas_erro ? ': ' + analise.vendas_erro : ''}</span>` : null}
        ${analise && analise.vendas_velhas ? html`<span class="rv-nd">usando a última planilha baixada</span>` : null}
      </div>
    </div>`;
}
function nameAbbrev(c){ return c.id; }

function ListaSuspeitos({ analise, t, onIr, onClose }) {
  const evs = analise.eventos || [];
  const [todos, setTodos] = useState(false);
  const lst = todos ? evs : evs.filter(e => e.vendas === 0);
  return html`<div class="rv-lista">
    <div class="rv-lista-topo">
      <b>${todos ? 'Todos os trechos com movimento' : 'Movimento sem venda'}</b>
      <label class="vd-muted"><input type="checkbox" checked=${todos} onChange=${e => setTodos(e.target.checked)} /> mostrar todos</label>
      <button class="iconbtn" onClick=${onClose}>✕</button>
    </div>
    ${!analise.vendas_ok ? html`<div class="vd-err" style=${{margin:'8px'}}>Sem as vendas do market4u não dá para separar os suspeitos. Conecte na barra "Vendas".</div>` : null}
    <div class="rv-lista-corpo">
      ${lst.length ? lst.map((e, i) => html`<button key=${i} class=${'rv-item' + (t >= e.inicio && t <= e.fim ? ' atual' : '')} onClick=${() => onIr(e)}>
          <span class=${'rv-l ' + (e.vendas === 0 ? 'sem' : e.vendas ? 'com' : 'nd')}></span>
          <b>${hhmmss(e.inicio)}</b><span>${Math.max(1, Math.round(e.duracao / 60))} min</span>
          <span class="vd-muted">${e.cams.length} câm.</span>
          <span class="vd-muted">${e.vendas === 0 ? 'sem venda' : e.vendas ? e.vendas + ' venda(s)' : '—'}</span>
        </button>`) : html`<div class="vd-empty"><span>${todos ? 'Nenhum movimento neste dia.' : 'Nenhum trecho sem venda neste dia. 👍'}</span></div>`}
    </div>
  </div>`;
}

function MarcarModal({ t, cameras, nameOf, analise, onClose, onFeito }) {
  const [autor, setAutor] = useState(lerAutor());
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [cams, setCams] = useState(cameras.map(c => c.id));
  const [gerar, setGerar] = useState(true);
  const [antes, setAntes] = useState(30);
  const [depois, setDepois] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // venda mais próxima (até 5 min) — fica registrada junto
  const venda = useMemo(() => {
    const v = (analise?.vendas || []).filter(v => Math.abs(v.t - t) <= 300).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    return v || null;
  }, [analise, t]);
  const enviar = async (e) => {
    e.preventDefault();
    if (!autor.trim()) { setErr('Informe o seu nome.'); return; }
    if (!cams.length) { setErr('Escolha pelo menos uma câmera.'); return; }
    setBusy(true); setErr(''); salvarAutor(autor.trim());
    const nomes = Object.fromEntries(cameras.map(c => [c.id, nameOf(c)]));
    try {
      const o = await api('/api/ocorrencias', { json: { t, titulo, descricao, autor: autor.trim(), cameras: cams,
        venda: venda ? { t: venda.t, total: venda.total, produtos: venda.produtos } : null,
        clipe: gerar ? { t0: t - antes, t1: t + depois, cameras: cams, nomes } : null } });
      onFeito(o);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return html`<${Modal} titulo=${'Marcar ocorrência — ' + hhmmss(t)} onClose=${onClose}>
    <form class="md-form" onSubmit=${enviar}>
      <label>Seu nome<input value=${autor} onInput=${e => setAutor(e.target.value)} placeholder="Quem está marcando" required /></label>
      <label>Título<input value=${titulo} onInput=${e => setTitulo(e.target.value)} placeholder="Ex.: pegou 2 refrigerantes e pagou 1" autofocus /></label>
      <label>Descrição<textarea rows="3" value=${descricao} onInput=${e => setDescricao(e.target.value)} placeholder="O que você viu, em qual câmera, roupa da pessoa…"></textarea></label>
      ${venda ? html`<div class="md-info">Venda mais próxima: <b>${hhmmss(venda.t)}</b> — ${brl(venda.total)} (${venda.produtos.join(', ')})</div>`
              : analise?.vendas_ok ? html`<div class="md-info">Nenhuma venda até 5 min deste horário.</div>` : null}
      <div class="md-rot">Câmeras envolvidas</div>
      <${EscolhaCameras} cameras=${cameras} nameOf=${nameOf} sel=${cams} onChange=${setCams} />
      <label class="vd-check"><input type="checkbox" checked=${gerar} onChange=${e => setGerar(e.target.checked)} />
        Gerar o clipe agora (a prova fica guardada mesmo depois que a gravação for limpa)</label>
      ${gerar ? html`<div class="md-linha">
        <label>Segundos antes<input type="number" min="0" max="240" value=${antes} onInput=${e => setAntes(+e.target.value || 0)} /></label>
        <label>Segundos depois<input type="number" min="5" max="240" value=${depois} onInput=${e => setDepois(+e.target.value || 0)} /></label>
      </div>` : null}
      ${err ? html`<div class="vd-err">${err}</div>` : null}
      <button class="vd-primary" disabled=${busy}>${busy ? 'Salvando…' : '🚩 Marcar ocorrência'}</button>
    </form>
  <//>`;
}

function ClipeModal({ t, cameras, nameOf, onClose }) {
  const [de, setDe] = useState(hhmmss(t - 30));
  const [ate, setAte] = useState(hhmmss(t + 30));
  const [cams, setCams] = useState(cameras.map(c => c.id));
  const [id, setId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const clipe = useClipe(id);
  const enviar = async (e) => {
    e.preventDefault(); setErr('');
    let t0 = horaParaEpoch(de, t), t1 = horaParaEpoch(ate, t);
    if (t0 == null || t1 == null) { setErr('Use o formato HH:MM:SS.'); return; }
    if (t1 <= t0) t1 += 86400;                     // passou da meia-noite
    if (!cams.length) { setErr('Escolha pelo menos uma câmera.'); return; }
    setBusy(true);
    try {
      const m = await api('/api/clipes', { json: { t0, t1, cameras: cams, autor: lerAutor(),
        nomes: Object.fromEntries(cameras.map(c => [c.id, nameOf(c)])) } });
      setId(m.id);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  return html`<${Modal} titulo="Exportar clipe" onClose=${onClose} largura=${520}>
    ${id ? html`<div class="md-form"><${EstadoClipe} clipe=${clipe} />
        <div class="vd-muted">O clipe também fica na aba Ocorrências → Clipes.</div></div>`
      : html`<form class="md-form" onSubmit=${enviar}>
        <div class="md-linha">
          <label>De<input value=${de} onInput=${e => setDe(e.target.value)} placeholder="HH:MM:SS" /></label>
          <label>Até<input value=${ate} onInput=${e => setAte(e.target.value)} placeholder="HH:MM:SS" /></label>
        </div>
        <div class="vd-muted">Até 5 minutos. As câmeras saem juntas num vídeo só, com data e hora.</div>
        <div class="md-rot">Câmeras</div>
        <${EscolhaCameras} cameras=${cameras} nameOf=${nameOf} sel=${cams} onChange=${setCams} />
        ${err ? html`<div class="vd-err">${err}</div>` : null}
        <button class="vd-primary" disabled=${busy}>🎬 Gerar clipe</button>
      </form>`}
  <//>`;
}
