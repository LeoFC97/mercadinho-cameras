// prateleiras.js — aba "Prateleiras": desenhar as zonas de interesse (prateleiras, geladeira) sobre a foto
// de cada câmera, catalogar os itens de cada zona e acompanhar as movimentações detectadas (o que saiu,
// se foi pago), com atalhos para a Revisão e para marcar ocorrência.
import { api, lerAutor, dataHora, hhmmss, isoDia } from './comum.js';
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

const corZona = (i) => `hsl(${(i * 83 + 190) % 360} 90% 60%)`;
const hojeIso = () => isoDia(Date.now() / 1000);
const addDias = (s, k) => { const [y, m, d] = s.split('-').map(Number); return isoDia(new Date(y, m - 1, d + k).getTime() / 1000); };
const brDia = s => s.split('-').reverse().join('/');
const TIPO = { retirada: 'provável retirada', reposicao: 'provável reposição', mexido: 'mexido' };

/* ---------------- quadro com a foto, zonas e itens ---------------- */
function Quadro({ src, zonas, sel, setSel, modo, novaZona, setNovaZona, onItemDesenhado, selItem, setSelItem }) {
  const area = useRef(null), quadro = useRef(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState({ w: 16, h: 9 });
  const [arr, setArr] = useState(null);
  const ini = useRef(null);
  useEffect(() => {
    const calc = () => { const a = area.current; if (!a) return; const W = a.clientWidth, H = a.clientHeight, r = nat.w / nat.h;
      setFit(W / H > r ? { w: H * r, h: H } : { w: W, h: W / r }); };
    calc(); const ro = new ResizeObserver(calc); if (area.current) ro.observe(area.current); return () => ro.disconnect();
  }, [nat.w, nat.h]);
  const ponto = (e) => { const r = quadro.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
  const down = (e) => {
    if (e.button !== 0) return;
    const p = ponto(e);
    if (modo === 'zona') {
      const pts = novaZona || [];
      if (pts.length >= 3 && Math.hypot((pts[0][0] - p.x) * fit.w, (pts[0][1] - p.y) * fit.h) < 14) { setNovaZona([...pts], true); return; }
      setNovaZona([...pts, [p.x, p.y]]); return;
    }
    if (modo === 'item') { e.preventDefault(); quadro.current.setPointerCapture(e.pointerId); ini.current = p; setArr({ x: p.x, y: p.y, w: 0, h: 0 }); }
  };
  const move = (e) => { if (!ini.current) return; const p = ponto(e), a = ini.current;
    setArr({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) }); };
  const up = () => { if (!ini.current) return; ini.current = null; if (arr && arr.w > 0.008 && arr.h > 0.008) onItemDesenhado(arr); setArr(null); };
  return html`<div class="pr-area" ref=${area}>
    <div class=${'pr-quadro modo-' + modo} ref=${quadro} style=${{ width: fit.w + 'px', height: fit.h + 'px' }}
         onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
      ${src ? html`<img src=${src} draggable="false" onLoad=${e => setNat({ w: e.target.naturalWidth || 16, h: e.target.naturalHeight || 9 })} />` : null}
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" class="pr-svg">
        ${zonas.map((z, i) => html`<polygon key=${z.id} points=${z.pontos.map(p => p.join(',')).join(' ')}
            class=${'pr-zona' + (sel === z.id ? ' sel' : '')} style=${{ stroke: corZona(i), fill: corZona(i) }}
            onPointerDown=${modo === 'ver' ? (e) => { e.stopPropagation(); setSel(z.id); setSelItem(null); } : null} />`)}
        ${novaZona && novaZona.length ? html`<polyline points=${novaZona.map(p => p.join(',')).join(' ')} class="pr-nova" />` : null}
      </svg>
      ${novaZona ? novaZona.map((p, i) => html`<div key=${i} class=${'pr-pt' + (i === 0 ? ' primeiro' : '')} style=${{ left: p[0] * 100 + '%', top: p[1] * 100 + '%' }}></div>`) : null}
      ${zonas.map((z, zi) => (z.itens || []).map(it => html`<div key=${it.id}
          class=${'pr-item' + (selItem === it.id ? ' sel' : '') + (it.classe == null && !it.nome ? ' sem' : '')}
          style=${{ left: it.x * 100 + '%', top: it.y * 100 + '%', width: it.w * 100 + '%', height: it.h * 100 + '%', borderColor: corZona(zi) }}
          onPointerDown=${modo !== 'zona' ? (e) => { e.stopPropagation(); setSel(z.id); setSelItem(it.id); } : null}>
          <span style=${{ background: corZona(zi) }}>${it.nome || '?'}</span></div>`))}
      ${arr ? html`<div class="pr-item novo" style=${{ left: arr.x * 100 + '%', top: arr.y * 100 + '%', width: arr.w * 100 + '%', height: arr.h * 100 + '%' }}></div>` : null}
      ${!src ? html`<div class="vd-empty" style=${{ position: 'absolute', inset: 0 }}><span>Sem foto de referência desta câmera.</span></div>` : null}
    </div>
  </div>`;
}

/* ---------------- editor de zonas e itens ---------------- */
function Editor({ dados, recarregar, cameras, nameOf, onToast }) {
  const [cam, setCam] = useState(cameras[0]?.id);
  const [sel, setSel] = useState(null);
  const [selItem, setSelItem] = useState(null);
  const [modo, setModo] = useState('ver');            // ver | zona | item
  const [novaZona, setNZ] = useState(null);
  const [classes, setClasses] = useState([]);
  const [busy, setBusy] = useState(false);
  const [armZ, setArmZ] = useState(false);
  useEffect(() => { api('/api/ia/resumo').then(r => setClasses(r.classes || [])).catch(() => {}); }, []);
  const zonas = (dados?.zonas || []).filter(z => z.cam === cam);
  const zona = zonas.find(z => z.id === sel) || null;
  const ref = dados?.refs?.[cam];
  const src = ref ? `/api/prateleiras/img/${ref.arquivo}?v=${Math.round(ref.em)}` : null;

  const salvarZona = async (z) => { try { await api('/api/prateleiras/zonas', { json: z }); await recarregar(); } catch (e) { onToast('Erro: ' + e.message); } };
  const fotoRef = async () => { setBusy(true); try { await api('/api/prateleiras/referencia', { json: { cam } }); await recarregar(); onToast('Foto de referência atualizada'); } catch (e) { onToast('Erro: ' + e.message); } setBusy(false); };
  const setNovaZona = async (pts, fechar) => {
    if (!fechar) { setNZ(pts); return; }
    const nome = `Prateleira ${zonas.length + 1}`;
    setNZ(null); setModo('ver');
    try { const z = await api('/api/prateleiras/zonas', { json: { cam, nome, pontos: pts, itens: [] } }); await recarregar(); setSel(z.id); onToast('Zona criada. Agora marque os itens dela.'); }
    catch (e) { onToast('Erro: ' + e.message); }
  };
  const itemDesenhado = async (r) => {
    if (!zona) { onToast('Escolha a zona primeiro.'); return; }
    const novo = { ...r, nome: '', classe: null, id: 'i' + Math.random().toString(16).slice(2, 8) };
    await salvarZona({ ...zona, itens: [...(zona.itens || []), novo] });
    setSelItem(novo.id);
  };
  const mudarItem = (id, patch) => salvarZona({ ...zona, itens: zona.itens.map(i => i.id === id ? { ...i, ...patch } : i) });
  const tirarItem = (id) => { salvarZona({ ...zona, itens: zona.itens.filter(i => i.id !== id) }); setSelItem(null); };
  const apagarZona = async () => {
    if (!armZ) { setArmZ(true); setTimeout(() => setArmZ(false), 4000); return; }
    try { await api(`/api/prateleiras/zonas/${zona.id}/apagar`, { json: {} }); setSel(null); recarregar(); } catch (e) { onToast('Erro: ' + e.message); }
  };
  useEffect(() => {
    const k = (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'Escape') { setNZ(null); setModo('ver'); }
      if (e.key === 'Enter' && modo === 'zona' && novaZona && novaZona.length >= 3) setNovaZona(novaZona, true); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [modo, novaZona, zonas.length, cam]);
  const it = zona && selItem ? (zona.itens || []).find(i => i.id === selItem) : null;

  return html`<div class="pr-ed">
    <div class="pr-centro">
      <div class="ia-linha">
        <div class="seg">${cameras.map(c => html`<button key=${c.id} class=${cam === c.id ? 'on' : ''} onClick=${() => { setCam(c.id); setSel(null); setSelItem(null); setNZ(null); setModo('ver'); }}>${nameOf(c)}</button>`)}</div>
        <button class="iconbtn" style=${{ width: 'auto', padding: '0 12px', fontSize: '12.5px' }} disabled=${busy} onClick=${fotoRef}>${busy ? 'Tirando foto…' : ref ? '📷 Atualizar foto' : '📷 Tirar foto de referência'}</button>
        <span style=${{ flex: 1 }}></span>
        <div class="seg">
          <button class=${modo === 'ver' ? 'on' : ''} onClick=${() => { setModo('ver'); setNZ(null); }}>Selecionar</button>
          <button class=${modo === 'zona' ? 'on' : ''} disabled=${!ref} onClick=${() => { setModo('zona'); setNZ([]); setSelItem(null); }}>＋ Zona</button>
          <button class=${modo === 'item' ? 'on' : ''} disabled=${!zona} onClick=${() => { setModo('item'); setNZ(null); }} title=${zona ? '' : 'Escolha uma zona primeiro'}>＋ Item</button>
        </div>
      </div>
      <${Quadro} src=${src} zonas=${zonas} sel=${sel} setSel=${setSel} modo=${modo} novaZona=${novaZona} setNovaZona=${setNovaZona}
        onItemDesenhado=${itemDesenhado} selItem=${selItem} setSelItem=${setSelItem} />
      <div class="ia-dica vd-muted">
        ${modo === 'zona' ? 'Clique nos cantos da prateleira (pode ser torta, em perspectiva). Clique no primeiro ponto ou aperte Enter para fechar; Esc cancela.'
          : modo === 'item' ? `Arraste um retângulo em cada lugar de produto dentro de "${zona?.nome || ''}". Depois escolha qual produto é, à direita.`
          : 'Clique numa zona ou num item para editar. Dica: tire a foto de referência com a prateleira cheia e arrumada.'}
        ${modo === 'zona' && novaZona && novaZona.length >= 3 ? html` <button class="vd-link" onClick=${() => setNovaZona(novaZona, true)}>Concluir zona</button>` : null}
      </div>
    </div>
    <div class="pr-dir">
      <div class="md-rot">Zonas desta câmera (${zonas.length})</div>
      ${zonas.map((z, i) => html`<button key=${z.id} class=${'ia-pitem' + (sel === z.id ? ' on' : '')} onClick=${() => { setSel(z.id); setSelItem(null); }}>
        <i style=${{ background: corZona(i) }}></i><span>${z.nome}</span><small>${(z.itens || []).length} itens</small></button>`)}
      ${!zonas.length ? html`<div class="vd-muted">${ref ? 'Nenhuma zona. Use "＋ Zona" e clique nos cantos da prateleira.' : 'Primeiro tire a foto de referência.'}</div>` : null}
      ${zona ? html`<div class="pr-zbox">
        <label class="pr-lab">Nome da zona<input class="ia-busca" key=${'n' + zona.id} defaultValue=${zona.nome} onBlur=${e => e.target.value.trim() && e.target.value !== zona.nome && salvarZona({ ...zona, nome: e.target.value.trim() })} onKeyDown=${e => e.key === 'Enter' && e.target.blur()} /></label>
        <label class="pr-lab">Sensibilidade: ${zona.sensibilidade.toFixed(1)}×
          <input type="range" min="0.3" max="3" step="0.1" value=${zona.sensibilidade} onChange=${e => salvarZona({ ...zona, sensibilidade: +e.target.value })} /></label>
        <div class="md-rot">Itens (${(zona.itens || []).length})</div>
        ${(zona.itens || []).map(i => html`<button key=${i.id} class=${'ia-pitem' + (selItem === i.id ? ' on' : '')} onClick=${() => setSelItem(i.id)}>
          <span>${i.nome || '— escolha o produto'}</span>${i.capacidade ? html`<small>cap. ${i.capacidade}</small>` : null}</button>`)}
        ${it ? html`<div class="pr-ibox">
          <label class="pr-lab">Produto
            <select class="oc-sel" value=${it.classe ?? ''} onChange=${e => { const c = classes.find(x => String(x.id) === e.target.value);
                mudarItem(it.id, c ? { classe: c.id, nome: c.nome, barras: c.barras || '' } : { classe: null }); }}>
              <option value="">— da lista de produtos da IA —</option>
              ${classes.map(c => html`<option key=${c.id} value=${c.id}>${c.nome}</option>`)}
            </select></label>
          <label class="pr-lab">ou nome livre<input class="ia-busca" key=${'in' + it.id + (it.nome || '')} defaultValue=${it.nome} placeholder="Ex.: Coca lata 350ml" onBlur=${e => e.target.value !== it.nome && mudarItem(it.id, { nome: e.target.value.trim(), classe: null })} onKeyDown=${e => e.key === 'Enter' && e.target.blur()} /></label>
          <label class="pr-lab">Capacidade (unidades nesse lugar)<input class="ia-busca" type="number" min="0" key=${'cap' + it.id} defaultValue=${it.capacidade || ''} onBlur=${e => (+e.target.value || 0) !== (it.capacidade || 0) && mudarItem(it.id, { capacidade: +e.target.value || 0 })} /></label>
          <button class="dbtn small" onClick=${() => tirarItem(it.id)}>Tirar item</button>
        </div>` : null}
        <button class=${'dbtn small' + (armZ ? ' armed' : '')} style=${{ marginTop: '10px' }} onClick=${apagarZona}>${armZ ? 'Confirmar?' : 'Apagar zona'}</button>
      </div>` : null}
    </div>
  </div>`;
}

/* ---------------- movimentações ---------------- */
function Movimentacoes({ dados, cameras, nameOf, onVer, onToast }) {
  const [dia, setDia] = useState(hojeIso());
  const [r, setR] = useState(null);
  const [filtro, setFiltro] = useState('mudou');     // mudou | suspeitos | todas
  const carregar = useCallback(async (d) => { try { setR(await api('/api/prateleiras/eventos?dia=' + d + '&_=' + Date.now())); } catch (e) { onToast('Erro: ' + e.message); } }, []);
  useEffect(() => { setR(null); carregar(dia); const id = setInterval(() => carregar(dia), 20000); return () => clearInterval(id); }, [dia]);
  const lst = (r?.eventos || []).filter(e => filtro === 'todas' ? true : filtro === 'suspeitos' ? e.suspeito : e.mudou);
  const nomeCam = id => { const c = cameras.find(x => x.id === id); return c ? nameOf(c) : id; };
  const marcar = async (e) => {
    const autor = lerAutor();
    if (!autor) { onToast('Escreva o seu nome na aba IA ou Ocorrências antes de marcar.'); return; }
    const itens = e.mudancas.map(m => m.nome || 'item').join(', ') || 'mexeram na prateleira';
    try {
      const o = await api('/api/ocorrencias', { json: { t: e.inicio, autor, cameras: [e.cam],
        titulo: `${e.suspeito ? 'Saiu sem venda' : 'Movimentação'}: ${itens} (${e.zona_nome})`.slice(0, 120),
        descricao: `Detectado automaticamente na ${e.zona_nome}, entre ${hhmmss(e.inicio)} e ${hhmmss(e.fim)}.`,
        clipe: { t0: e.inicio - 20, t1: e.fim + 20, cameras: cameras.map(c => c.id), nomes: Object.fromEntries(cameras.map(c => [c.id, nameOf(c)])) } } });
      await api(`/api/prateleiras/eventos/${dia}/${e.id}`, { json: { ocorrencia: o.id } });
      onToast('Ocorrência marcada (o clipe está sendo gerado)'); carregar(dia);
    } catch (err) { onToast('Erro: ' + err.message); }
  };
  const conferir = async (e) => { try { await api(`/api/prateleiras/eventos/${dia}/${e.id}`, { json: { conferido: !e.conferido } }); carregar(dia); } catch (err) { onToast('Erro: ' + err.message); } };
  const reanalisar = async () => { try { await api('/api/prateleiras/reanalisar', { json: { dia } }); onToast('O dia será analisado de novo (os trechos que ainda existem)'); setTimeout(() => carregar(dia), 4000); } catch (err) { onToast('Erro: ' + err.message); } };
  const ate = dados?.analisado_ate || {};
  return html`<div class="pr-mov">
    <div class="ia-linha">
      <div class="seg">
        <button onClick=${() => setDia(addDias(dia, -1))}>◀</button>
        <button class="on" style=${{ cursor: 'default' }}>${dia === hojeIso() ? 'Hoje' : brDia(dia)}</button>
        <button onClick=${() => setDia(addDias(dia, 1))} disabled=${dia >= hojeIso()}>▶</button>
      </div>
      <div class="seg">${[['mudou', 'Item mexido'], ['suspeitos', 'Sem venda'], ['todas', 'Todas']].map(([k, t]) =>
        html`<button key=${k} class=${filtro === k ? 'on' : ''} onClick=${() => setFiltro(k)}>${t}</button>`)}</div>
      <span class="vd-muted">${r ? lst.length + ' movimentação(ões)' : ''}</span>
      <span style=${{ flex: 1 }}></span>
      <span class="vd-muted">${Object.keys(ate).length ? 'analisado até ' + Object.entries(ate).map(([c, t]) => `${nomeCam(c)} ${hhmmss(t)}`).join(' · ') : 'analisador ainda não rodou'}</span>
      <button class="vd-link" onClick=${reanalisar}>↻ Reanalisar o dia</button>
    </div>
    ${r && !r.vendas_ok && (r.eventos || []).length ? html`<div class="vd-err">Sem as vendas do market4u não dá para saber se foi pago${r.vendas_erro ? ': ' + r.vendas_erro : ''}.</div>` : null}
    <div class="pr-lista">
      ${lst.map(e => html`<div key=${e.id} class=${'pr-ev' + (e.suspeito ? ' suspeito' : '') + (e.conferido ? ' conferido' : '')}>
        <div class="pr-ev-cab">
          <b>${hhmmss(e.inicio)}</b><span class="vd-muted">até ${hhmmss(e.fim)}</span>
          <span>${e.zona_nome}</span><span class="vd-muted">${nomeCam(e.cam)}</span>
          ${e.suspeito ? html`<span class="oc-chip" style=${{ color: '#f0506e', borderColor: '#f0506e' }}>sem venda</span>` : null}
          ${e.conferido ? html`<span class="oc-chip" style=${{ color: '#36d399', borderColor: '#36d399' }}>conferido</span>` : null}
          ${e.ocorrencia ? html`<span class="oc-chip" style=${{ color: '#fbbf24', borderColor: '#fbbf24' }}>⚑ ocorrência</span>` : null}
        </div>
        <div class="pr-ev-corpo">
          <div class="pr-ab">
            <figure>${e.img_antes ? html`<img src=${'/api/prateleiras/img/' + e.img_antes} loading="lazy" />` : html`<div class="pr-noimg"></div>`}<figcaption>antes ${hhmmss(e.antes_t)}</figcaption></figure>
            <figure>${e.img_depois ? html`<img src=${'/api/prateleiras/img/' + e.img_depois} loading="lazy" />` : html`<div class="pr-noimg"></div>`}<figcaption>depois ${hhmmss(e.depois_t)}</figcaption></figure>
          </div>
          <div class="pr-mud">
            ${e.mudancas.length ? e.mudancas.map((m, i) => html`<div key=${i} class="pr-m">
                <b>${m.nome || 'item sem nome'}</b><span class="vd-muted">${TIPO[m.tipo] || m.tipo}</span>
                ${m.paga === true ? html`<span style=${{ color: '#36d399' }}>✔ teve venda</span>` : m.paga === false ? html`<span style=${{ color: '#f0506e' }}>✗ sem venda</span>` : null}
              </div>`)
              : html`<div class="vd-muted">${e.mudou ? '' : 'Mexeram na zona, mas nenhum item catalogado mudou.'}</div>`}
            ${e.vendas_perto && e.vendas_perto.length ? html`<div class="vd-muted pr-vp">Vendas perto: ${e.vendas_perto.map(v => `${hhmmss(v.t)} ${v.produto}`).join(' · ')}</div>` : null}
            <div class="oc-acoes" style=${{ marginTop: '8px' }}>
              <button class="vd-primary" onClick=${() => onVer(e.inicio - 8)}>▶ Ver na Revisão</button>
              ${e.ocorrencia ? null : html`<button class="iconbtn" style=${{ width: 'auto', padding: '0 10px', fontSize: '12px' }} onClick=${() => marcar(e)}>🚩 Marcar ocorrência</button>`}
              <button class="vd-link" onClick=${() => conferir(e)}>${e.conferido ? 'Desmarcar conferido' : '✔ Conferido'}</button>
            </div>
          </div>
        </div>
      </div>`)}
      ${r && !lst.length ? html`<div class="vd-empty"><span>${(dados?.zonas || []).length ? 'Nenhuma movimentação neste dia com esse filtro.' : 'Cadastre as zonas e os itens na aba "Zonas e itens" para começar.'}</span></div>` : null}
    </div>
  </div>`;
}

/* ---------------- aba ---------------- */
export function PrateleirasView({ cameras, nameOf, onExit, onVer, extraButtons, onToast }) {
  const [aba, setAba] = useState('zonas');
  const [dados, setDados] = useState(null);
  const recarregar = useCallback(() => api('/api/prateleiras?_=' + Date.now()).then(setDados).catch(e => onToast('Erro: ' + e.message)), []);
  useEffect(() => { recarregar(); }, []);
  const nz = (dados?.zonas || []).length, ni = (dados?.zonas || []).reduce((s, z) => s + (z.itens || []).length, 0);
  return html`<div style=${{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
    <div class="topbar">
      <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>✕</button>
      <div class="brand"><h1>Prateleiras</h1><small>${nz} zona(s) · ${ni} item(ns)</small></div>
      <div class="seg">
        <button class=${aba === 'zonas' ? 'on' : ''} onClick=${() => setAba('zonas')}>Zonas e itens</button>
        <button class=${aba === 'mov' ? 'on' : ''} onClick=${() => { setAba('mov'); recarregar(); }}>Movimentações</button>
      </div>
      <div class="spacer"></div>
      ${extraButtons || null}
    </div>
    <div class="ia-corpo">
      ${aba === 'zonas' ? html`<${Editor} dados=${dados} recarregar=${recarregar} cameras=${cameras} nameOf=${nameOf} onToast=${onToast} />`
        : html`<${Movimentacoes} dados=${dados} cameras=${cameras} nameOf=${nameOf} onVer=${onVer} onToast=${onToast} />`}
    </div>
  </div>`;
}
