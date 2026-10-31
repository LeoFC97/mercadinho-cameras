// review.js — modo Revisão: as 4 câmeras andando juntas no passado.
// Lê os segmentos gravados (/rec) e sincroniza o playback por horário (epoch).
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

export function ReviewView({ cameras, nameOf, go2rtc, onExit }) {
  const [manifest, setManifest] = useState(null);
  const [day, setDay] = useState(null);
  const [index, setIndex] = useState({});     // camId -> [ {t,d,m,f} ] ordenado
  const [range, setRange] = useState(null);   // {start,end} epoch do dia com gravação
  const [dispT, setDispT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [err, setErr] = useState('');

  const tRef = useRef(0), playingRef = useRef(false), speedRef = useRef(1);
  const vids = useRef({});       // camId -> <video>
  const cur = useRef({});        // camId -> arquivo carregado
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; for (const v of Object.values(vids.current)) if (v) v.playbackRate = Math.min(speed, 4); }, [speed]);

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
      setRange({ start: s, end: e });
      tRef.current = s; setDispT(s);
    })();
    return () => { alive = false; };
  }, [day, cameras]);

  // garante o segmento certo em cada <video> para o tempo t
  const syncCam = (camId, t, play) => {
    const v = vids.current[camId]; if (!v) return false;
    const list = index[camId] || [];
    const i = segAt(list, t);
    if (i < 0) { // sem gravação nesse instante
      if (cur.current[camId] !== null) { cur.current[camId] = null; v.removeAttribute('src'); v.load(); }
      return false;
    }
    const seg = list[i];
    const want = seg.f;
    if (cur.current[camId] !== want) {
      cur.current[camId] = want;
      v.src = `/rec/${camId}/${want}`;
      v.load();
      const off = Math.max(0, t - seg.t);
      const onmeta = () => { try { v.currentTime = off; v.playbackRate = Math.min(speedRef.current, 4); if (play) v.play().catch(() => {}); } catch {} v.removeEventListener('loadedmetadata', onmeta); };
      v.addEventListener('loadedmetadata', onmeta);
      return true;
    }
    // mesmo segmento: corrige deriva
    const target = t - seg.t;
    if (Math.abs(v.currentTime - target) > 0.4) { try { v.currentTime = target; } catch {} }
    if (play && v.paused) v.play().catch(() => {});
    if (!play && !v.paused) v.pause();
    return true;
  };

  // escolhe a câmera "mestre" (primeira com gravação em t)
  const masterAt = (t) => {
    for (const c of cameras) { if (segAt(index[c.id] || [], t) >= 0) return c.id; }
    return null;
  };
  const nextSegStart = (t) => {
    let best = Infinity;
    for (const c of cameras) for (const seg of (index[c.id] || [])) if (seg.t > t + 0.1) best = Math.min(best, seg.t);
    return best === Infinity ? null : best;
  };

  // loop de sincronização (5 Hz)
  useEffect(() => {
    if (!range) return;
    const id = setInterval(() => {
      let t = tRef.current;
      const play = playingRef.current;
      if (play) {
        const mid = masterAt(t);
        if (mid) {
          const v = vids.current[mid];
          const list = index[mid]; const i = segAt(list, t);
          if (v && i >= 0 && v.readyState >= 2 && cur.current[mid] === list[i].f) {
            t = list[i].t + v.currentTime;        // tempo guiado pelo vídeo mestre
          } else {
            t = t + 0.2 * speedRef.current;        // ainda carregando: avança no relógio
          }
          if (t >= range.end - 0.1) { t = range.end; playingRef.current = false; setPlaying(false); }
        } else {
          const ns = nextSegStart(t);              // pula buraco sem gravação
          if (ns) t = ns; else { t = range.end; playingRef.current = false; setPlaying(false); }
        }
        tRef.current = t;
      }
      for (const c of cameras) syncCam(c.id, tRef.current, playingRef.current);
      setDispT(tRef.current);
    }, 200);
    return () => clearInterval(id);
  }, [range, index, cameras]);

  const seekTo = (t) => {
    const r = range; if (!r) return;
    t = Math.max(r.start, Math.min(r.end, t));
    tRef.current = t; setDispT(t);
    for (const c of cameras) { cur.current[c.id] = cur.current[c.id]; syncCam(c.id, t, playingRef.current); }
  };
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
        ${manifest && manifest.disk ? html`<div class="stat">disco <b>${manifest.disk.used_gb}</b>/${manifest.disk.cap_gb} GB</div>` : null}
        <div class="clock">${range ? hhmmss(dispT) : '--:--:--'}</div>
      </div>

      <div class="stage">
        ${err
          ? html`<div class="offbox" style=${{position:'static',height:'100%'}}><span>${err}</span></div>`
          : html`<div class=${'grid ' + cols} style=${{height:'100%'}}>
              ${cameras.map(c => html`
                <div class="tile" key=${c.id}>
                  <video ref=${el => { vids.current[c.id] = el; }} muted playsinline
                     style=${{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',background:'#000'}}></video>
                  ${segAt(index[c.id] || [], dispT) < 0
                    ? html`<div class="offbox"><span>sem gravação</span></div>` : null}
                  <div class="sheen"></div>
                  <div class="cap"><span class="name">${nameOf(c)}</span><span class="ts">${c.ip || ''}</span></div>
                </div>`)}
            </div>`}
      </div>

      ${range ? html`<${Controls}
          range=${range} t=${dispT} playing=${playing} speed=${speed}
          index=${index} cameras=${cameras}
          onSeek=${seekTo} onToggle=${togglePlay} onStep=${step}
          onSpeed=${setSpeed} onMotion=${nextMotion} I=${I} /> ` : null}
    </div>`;
}

// Barra de controles + linha do tempo com mapa de movimento
function Controls({ range, t, playing, speed, index, cameras, onSeek, onToggle, onStep, onSpeed, onMotion, I }) {
  const barRef = useRef(null);
  const span = Math.max(1, range.end - range.start);
  const pct = ((t - range.start) / span) * 100;

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

  return html`
    <div style=${{flex:'0 0 auto',padding:'10px 14px 14px',borderTop:'1px solid var(--line)',background:'var(--bg2)'}}>
      <div style=${{display:'flex',alignItems:'center',gap:'10px',marginBottom:'10px'}}>
        <button class="iconbtn" title="Movimento anterior" onClick=${() => onMotion(-1)}>${I.prev}</button>
        <button class="iconbtn" style=${{width:'44px'}} title=${playing ? 'Pausar' : 'Reproduzir'} onClick=${onToggle}>${playing ? I.pause : I.play}</button>
        <button class="iconbtn" title="Próximo movimento" onClick=${() => onMotion(1)}>${I.next}</button>
        <button class="iconbtn" style=${{width:'auto',padding:'0 10px',fontSize:'12px',fontWeight:600}} onClick=${() => onStep(-10)}>−10s</button>
        <button class="iconbtn" style=${{width:'auto',padding:'0 10px',fontSize:'12px',fontWeight:600}} onClick=${() => onStep(10)}>+10s</button>
        <div class="spacer" style=${{flex:1}}></div>
        <div class="seg">
          ${[0.5,1,2,4,8].map(s => html`<button class=${speed===s?'on':''} onClick=${() => onSpeed(s)}>${s}×</button>`)}
        </div>
      </div>
      <div ref=${barRef} onMouseDown=${(e)=>{setDrag(true);onBar(e);}}
        style=${{position:'relative',height:'54px',background:'var(--panel)',border:'1px solid var(--line)',borderRadius:'10px',overflow:'hidden',cursor:'pointer'}}>
        ${cameras.map((c, ci) => {
          const rowH = 54 / cameras.length;
          return (index[c.id] || []).map(seg => {
            const left = ((seg.t - range.start) / span) * 100;
            const w = Math.max(0.15, (seg.d / span) * 100);
            const mot = seg.m >= MOTION_TH;
            return html`<div key=${c.id+seg.f} title=${nameAbbrev(c)+' '+hhmmss(seg.t)+(mot?' • movimento':'')}
              style=${{position:'absolute',left:left+'%',width:w+'%',top:(ci*rowH)+'px',height:(rowH-1)+'px',
                       background: mot ? 'var(--accent)' : 'rgba(120,140,170,.28)'}}></div>`;
          });
        })}
        ${ticks.map(tk => { const l = ((tk - range.start)/span)*100; return html`<div key=${tk}
          style=${{position:'absolute',left:l+'%',top:0,bottom:0,width:'1px',background:'rgba(255,255,255,.08)'}}>
          <span style=${{position:'absolute',top:'2px',left:'3px',fontSize:'9px',color:'var(--muted2)'}}>${hhmm(tk)}</span></div>`; })}
        <div style=${{position:'absolute',left:pct+'%',top:0,bottom:0,width:'2px',background:'#fff',boxShadow:'0 0 6px rgba(255,255,255,.8)'}}></div>
      </div>
    </div>`;
}
function nameAbbrev(c){ return c.id; }
