// disk.js — tela "Disco": uso das gravações por dia/câmera e limpeza pelo próprio painel.
// Usa a API do painel_server: GET /api/disk e POST /api/disk/delete.
const { useState, useEffect, useCallback } = React;
const html = htm.bind(React.createElement);

const fmtGB = b => (b / 1e9 >= 1 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const fmtDay = d => { const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function api(url, opts) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || ('HTTP ' + r.status));
  return j;
}

// Botão que pede confirmação no segundo clique (sem diálogo do navegador)
function Danger({ label, onConfirm, small }) {
  const [arm, setArm] = useState(false);
  useEffect(() => { if (!arm) return; const id = setTimeout(() => setArm(false), 4000); return () => clearTimeout(id); }, [arm]);
  return html`<button class=${'dbtn' + (arm ? ' armed' : '') + (small ? ' small' : '')}
      onClick=${() => { if (arm) { setArm(false); onConfirm(); } else setArm(true); }}>
      ${arm ? 'Confirmar?' : label}</button>`;
}

export function DiskView({ cameras, nameOf, onExit, onToast }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [olderDays, setOlderDays] = useState(3);
  const [open, setOpen] = useState({});   // dia -> mostra câmeras

  const load = useCallback(async () => {
    try { setData(await api('/api/disk?_=' + Date.now())); setErr(''); }
    catch (e) { setErr('Não consegui ler o disco: ' + e.message); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);

  const del = async (req, what) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api('/api/disk/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
      onToast(`${what}: ${r.files} arquivo(s), ${fmtGB(r.freed_bytes)} liberados`);
      await load();
    } catch (e) { onToast('Erro ao apagar: ' + e.message); }
    finally { setBusy(false); }
  };

  const camName = id => { const c = cameras.find(x => x.id === id); return c ? nameOf(c) : id; };
  const disk = data?.disk;
  const total = disk?.total_gb || 0;
  const usedPct = disk && total ? Math.min(100, (disk.used_gb / total) * 100) : 0;
  const otherPct = disk && total ? Math.max(0, Math.min(100 - usedPct, ((total - disk.free_gb - disk.used_gb) / total) * 100)) : 0;
  const capPct = disk && total ? Math.min(100, (disk.cap_gb / total) * 100) : 0;
  const orphans = (data?.cams || []).filter(c => !c.active);
  const days = (data?.days || []).slice().reverse();   // mais recente primeiro
  const today = todayStr();

  const I = {
    live: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>`,
    refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>`,
  };

  return html`
    <div style=${{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div class="topbar">
        <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>${I.live}</button>
        <div class="brand"><h1>Disco</h1><small>gravações</small></div>
        <div class="spacer"></div>
        ${disk ? html`<div class="stat">gravações <b>${disk.used_gb} GB</b> · teto ${disk.cap_gb} GB · livre <b>${disk.free_gb} GB</b></div>` : null}
        <button class="iconbtn" title="Atualizar" onClick=${load}>${I.refresh}</button>
      </div>

      <div class="stage" style=${{ overflow: 'auto' }}>
        ${err ? html`<div class="offbox" style=${{position:'static',height:'100%'}}><span>${err}</span></div>` : null}
        ${!err && !data ? html`<div class="offbox" style=${{position:'static',height:'100%'}}><div class="spin"></div></div>` : null}
        ${data ? html`
          <div class="dpanel">
            <div class="dhead">
              <div>
                <div class="dtitle">Uso do disco</div>
                <div class="dsub">${disk.used_gb} GB em gravações · ${disk.free_gb} GB livres de ${disk.total_gb} GB · teto automático ${disk.cap_gb} GB · retenção ${Math.round(disk.retention_hours / 24)} dias</div>
              </div>
            </div>
            <div class="dbar" title="azul = gravações · cinza = resto do sistema · marca = teto">
              <div class="rec" style=${{ width: usedPct + '%' }}></div>
              <div class="other" style=${{ width: otherPct + '%' }}></div>
              <div class="cap" style=${{ left: capPct + '%' }}></div>
            </div>
            <div class="dactions">
              <span>Apagar gravações com mais de</span>
              <input type="number" min="0" max="365" value=${olderDays} onChange=${e => setOlderDays(Math.max(0, +e.target.value || 0))} />
              <span>dias</span>
              <${Danger} label="Apagar antigas" onConfirm=${() => del({ older_than_days: olderDays }, `Mais de ${olderDays} dia(s)`)} />
            </div>
          </div>

          ${orphans.length ? html`
            <div class="dpanel">
              <div class="dtitle">Pastas de câmeras antigas</div>
              <div class="dsub">Câmeras que não estão mais na configuração (mudaram de IP). Essas gravações não aparecem na Revisão e podem ser apagadas.</div>
              ${orphans.map(c => html`<div class="drow" key=${c.id}>
                <span class="dname">${c.id}</span>
                <span class="dsize">${fmtGB(c.bytes)}</span>
                <span class="dmeta">${c.days.reduce((a, d) => a + d.segs, 0)} trechos</span>
                <span class="spacer"></span>
                <${Danger} small label="Apagar pasta" onConfirm=${() => del({ orphan: c.id }, 'Pasta ' + c.id)} />
              </div>`)}
            </div>` : null}

          <div class="dpanel">
            <div class="dtitle">Por dia</div>
            ${!days.length ? html`<div class="dsub">Nenhuma gravação no disco.</div>` : null}
            ${days.map(d => html`
              <div key=${d.day}>
                <div class=${'drow' + (open[d.day] ? ' open' : '')} onClick=${() => setOpen(o => ({ ...o, [d.day]: !o[d.day] }))} style=${{cursor:'pointer'}}>
                  <span class="dname">${fmtDay(d.day)}${d.day === today ? html`<em> hoje</em>` : null}</span>
                  <span class="dsize">${fmtGB(d.bytes)}</span>
                  <span class="dmeta">${d.segs} trechos · ${Object.keys(d.cams).length} câmera(s)</span>
                  <span class="spacer"></span>
                  <span onClick=${e => e.stopPropagation()}>
                    <${Danger} small label="Apagar dia" onConfirm=${() => del({ day: d.day }, 'Dia ' + fmtDay(d.day))} />
                  </span>
                </div>
                ${open[d.day] ? html`<div class="dsubrows">
                  ${Object.entries(d.cams).sort().map(([cid, b]) => html`<div class="drow sub" key=${cid}>
                    <span class="dname">${camName(cid)} <span class="dmeta">${cid}</span></span>
                    <span class="dsize">${fmtGB(b)}</span>
                    <span class="spacer"></span>
                    <span onClick=${e => e.stopPropagation()}>
                      <${Danger} small label="Apagar" onConfirm=${() => del({ cam: cid, day: d.day }, `${camName(cid)} em ${fmtDay(d.day)}`)} />
                    </span>
                  </div>`)}
                </div>` : null}
              </div>`)}
          </div>` : null}
      </div>
    </div>`;
}
