// estoque.js — Estoque do CD e da loja (market4u), quanto dura cada produto pelo giro de vendas,
// e a lista de compras: sugestões do que vai acabar, último preço pago (barato ou caro hoje?) e envio pelo WhatsApp.
import { api, two } from './comum.js';
const { useState, useEffect, useMemo, useRef } = React;
const html = htm.bind(React.createElement);

const brl = v => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const br = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + (s.slice(0, 4) !== String(new Date().getFullYear()) ? '/' + s.slice(2, 4) : '') : '';
const titulo = s => (s || '').toLowerCase().replace(/(^|\s|\/)\S/g, c => c.toUpperCase());
const ha = t => { if (!t) return 'nunca'; const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `há ${Math.floor(m / 1440)} dia(s)`; };
const em = t => { const m = Math.round((t - Date.now() / 1000) / 60); return m <= 0 ? 'em instantes' : `em ${m} min`; };

const STATUS = {
  acabou: ['Acabou', 'est-st acabou', 'Vende e não tem mais no CD nem na loja'],
  critico: ['Acaba em até 3 dias', 'est-st critico', ''],
  acabando: ['Acaba antes da próxima compra', 'est-st acabando', ''],
  ok: ['OK', 'est-st ok', ''],
  parado: ['Parado', 'est-st parado', 'Tem estoque mas não vendeu nada no período'],
  sem_giro: ['Sem venda', 'est-st semgiro', 'Sem estoque e sem venda no período'],
};

function Status({ p, T }) {
  const [rot, cls, dica] = STATUS[p.status] || ['—', 'est-st', ''];
  const txt = p.status === 'acabando' ? `Dura ~${num(p.cobertura_dias)} dias` : p.status === 'critico' ? (p.cobertura_dias < 1 ? 'Acaba hoje' : `Dura ~${num(p.cobertura_dias)} dia(s)`) : rot;
  return html`<span class=${cls} title=${dica || (p.cobertura_dias != null ? `Com ${num(p.cd + p.loja)} un e vendendo ${num(p.media_dia, 1)}/dia` : '')}>${txt}</span>`;
}

// preço de hoje x histórico de compra
function comparaPreco(hoje, p) {
  if (!hoje || !p) return null;
  const ref = p.preco_medio || p.ultimo_preco;
  if (!ref) return null;
  const v = (hoje - ref) / ref * 100;
  const vu = p.ultimo_preco ? (hoje - p.ultimo_preco) / p.ultimo_preco * 100 : null;
  let cls = 'normal', txt = 'preço normal';
  if (p.preco_min && hoje < p.preco_min - 0.005) { cls = 'barato'; txt = 'o mais barato até hoje'; }
  else if (v <= -5) { cls = 'barato'; txt = 'barato'; }
  else if (p.preco_max && hoje > p.preco_max + 0.005) { cls = 'caro'; txt = 'o mais caro até hoje'; }
  else if (v >= 5) { cls = 'caro'; txt = 'caro'; }
  return { cls, txt, v, vu };
}

function Barra({ v, max }) {
  const p = max > 0 ? Math.min(100, v / max * 100) : 0;
  return html`<span class="est-mini"><i style=${{ width: p + '%', background: p <= 0 ? 'transparent' : p < 30 ? '#e66767' : p < 60 ? '#eda100' : '#3987e5' }}></i></span>`;
}

function Historico({ p }) {
  if (!p.historico || !p.historico.length) return html`<span class="vd-muted">sem compras registradas</span>`;
  return html`<span class="est-hist">${p.historico.slice().reverse().map((h, i) => html`<span key=${i} title=${h.tipo + ' · ' + num(h.qtd) + ' un'}>${br(h.data)} ${brl(h.preco)}</span>`)}</span>`;
}

// ---------- visão de estoque ----------
function VisaoEstoque({ d, naLista, onAdd }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [st, setSt] = useState('');
  const [semCd, setSemCd] = useState(false);
  const [ord, setOrd] = useState(['', 1]);
  const [aberto, setAberto] = useState(null);
  const [limite, setLimite] = useState(80);
  const T = d.config.dias_cobertura;
  const cats = useMemo(() => [...new Set(d.produtos.map(p => p.categoria).filter(Boolean))].sort(), [d]);
  const lista = useMemo(() => {
    let l = d.produtos;
    if (q) { const s = q.toLowerCase(); l = l.filter(p => (p.nome + ' ' + p.codigo + ' ' + p.barras + ' ' + p.categoria + ' ' + (p.fornecedor || '')).toLowerCase().includes(s)); }
    if (cat) l = l.filter(p => p.categoria === cat);
    if (st === 'alerta') l = l.filter(p => ['acabou', 'critico', 'acabando'].includes(p.status));
    else if (st === 'loja') l = l.filter(p => p.capacidade > 0 && p.loja <= 0);
    else if (st) l = l.filter(p => p.status === st);
    if (semCd) l = l.filter(p => p.cd <= 0 && p.media_dia > 0);
    if (ord[0]) { const [k, dir] = ord; l = [...l].sort((a, b) => { const x = a[k] ?? -1e9, y = b[k] ?? -1e9; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; }); }
    return l;
  }, [d, q, cat, st, semCd, ord]);
  const r = d.resumo;
  const th = (k, rot, n) => html`<th class=${n ? 'n' : ''} onClick=${() => setOrd(o => [k, o[0] === k ? -o[1] : (n ? -1 : 1)])}>${rot}${ord[0] === k ? (ord[1] < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  const chips = [['', 'Todos'], ['alerta', `Vão acabar (${r.acabou + r.critico + r.acabando})`], ['acabou', `Acabou (${r.acabou})`], ['loja', `Faltando na loja (${r.ruptura_loja})`], ['parado', `Parados (${r.parados})`]];
  return html`<div>
    <div class="est-cards">
      <div><small>No CD</small><b>${brl(r.valor_cd)}</b><span>${num(r.unidades_cd)} un · ${r.produtos_cd} produtos</span></div>
      <div><small>Na loja</small><b>${brl(r.valor_loja)}</b><span>${num(r.unidades_loja)} un · ${r.produtos_loja} produtos</span></div>
      <div class="ruim" onClick=${() => setSt('acabou')}><small>Acabaram (e vendem)</small><b>${r.acabou}</b><span>sem nada no CD nem na loja</span></div>
      <div class="alerta" onClick=${() => setSt('alerta')}><small>Acabam em até ${T} dias</small><b>${r.critico + r.acabando}</b><span>${r.critico} em até 3 dias</span></div>
      <div onClick=${() => { setSemCd(true); setSt(''); }}><small>Vendem e não têm no CD</small><b>${r.sem_cd_vendendo}</b><span>só o que está na loja</span></div>
      <div onClick=${() => setSt('parado')}><small>Parados (sem venda em ${d.config.dias_giro} dias)</small><b>${r.parados}</b><span>${brl(r.valor_parado)} parados</span></div>
    </div>
    <div class="est-filtros">
      <input class="db-busca" placeholder="Buscar produto, código, fornecedor…" value=${q} onInput=${e => setQ(e.target.value)} />
      <select value=${cat} onChange=${e => setCat(e.target.value)}><option value="">Todas as categorias</option>${cats.map(c => html`<option key=${c} value=${c}>${titulo(c)}</option>`)}</select>
      <div class="est-chips">${chips.map(([k, rot]) => html`<button key=${k} class=${st === k ? 'on' : ''} onClick=${() => setSt(k)}>${rot}</button>`)}</div>
      <label class="db-chk"><input type="checkbox" checked=${semCd} onChange=${e => setSemCd(e.target.checked)} /> só os que vendem e não têm no CD</label>
    </div>
    <div class="db-tab-wrap"><table class="db-tab est-tab">
      <thead><tr>${th('nome', 'Produto')}${th('loja', 'Loja', 1)}${th('cd', 'CD', 1)}${th('media_dia', 'Vende/dia', 1)}${th('cobertura_dias', 'Dura', 1)}${th('ultimo_preco', 'Último preço', 1)}${th('sugestao', 'Comprar', 1)}<th></th></tr></thead>
      <tbody>${lista.slice(0, limite).map(p => html`<${React.Fragment} key=${p.chave}>
        <tr class=${aberto === p.chave ? 'aberto' : ''} onClick=${() => setAberto(a => a === p.chave ? null : p.chave)}>
          <td><div class="db-pnome">${p.nome}</div><small class="vd-muted">${titulo(p.categoria)}${p.codigo ? ' · ' + p.codigo : ''}</small></td>
          <td class="n">${p.capacidade ? html`<${Barra} v=${p.loja} max=${p.capacidade} /> ${num(p.loja)}<small class="vd-muted">/${num(p.capacidade)}</small>` : num(p.loja)}</td>
          <td class=${'n' + (p.cd <= 0 && p.media_dia > 0 ? ' db-ruim' : '')}>${num(p.cd)}</td>
          <td class="n">${p.media_dia ? num(p.media_dia, 1) : '—'}${p.media_dia && p.media_dia7 > p.media_dia * 1.25 ? html` <span class="db-delta bom" title=${'últimos 7 dias: ' + num(p.media_dia7, 1) + '/dia'}>▲</span>` : p.media_dia && p.media_dia7 < p.media_dia * 0.75 ? html` <span class="db-delta ruim" title=${'últimos 7 dias: ' + num(p.media_dia7, 1) + '/dia'}>▼</span>` : null}</td>
          <td class="n"><${Status} p=${p} T=${d.config.dias_cobertura} /></td>
          <td class="n">${p.ultimo_preco ? html`${brl(p.ultimo_preco)}<br /><small class="vd-muted">${br(p.ultima_compra)}</small>` : html`<small class="vd-muted">custo ${brl(p.custo)}</small>`}</td>
          <td class="n">${p.sugestao ? html`<b>${num(p.sugestao)}</b>` : '—'}</td>
          <td class="n" onClick=${e => e.stopPropagation()}>${naLista.has(p.chave) ? html`<span class="est-nalista">✓ na lista</span>`
            : html`<button class="est-add" title="Pôr na lista de compras" onClick=${() => onAdd(p)}>+ lista</button>`}</td>
        </tr>
        ${aberto === p.chave ? html`<tr class="est-det"><td colspan="8">
          <div class="est-det-grid">
            <div><small>Vendeu</small>${num(p.vendidos)} un em ${d.resumo.dias_vendas} dias (${num(p.vendidos7)} nos últimos 7) · ${brl(p.faturamento)}</div>
            <div><small>Preço de venda médio</small>${brl(p.preco_venda)}${p.preco_venda && p.ultimo_preco ? html` · margem ${num((p.preco_venda - p.ultimo_preco) / p.preco_venda * 100)}% sobre o último preço` : null}</div>
            <div><small>Saiu do CD para a loja (30 dias)</small>${num(p.saidas_cd30)} un</div>
            <div><small>Última venda</small>${p.ultima_venda ? br(p.ultima_venda.slice(0, 10)) + ' ' + p.ultima_venda.slice(11, 16) : '—'}${p.dias_sem_venda ? ` (há ${p.dias_sem_venda} dias)` : ''}</div>
            <div><small>Preço de compra</small>${p.preco_medio ? html`médio ${brl(p.preco_medio)} · mín ${brl(p.preco_min)} · máx ${brl(p.preco_max)} · ${p.compras} compra(s)` : '—'}</div>
            <div><small>Fornecedor</small>${p.fornecedor || '—'}</div>
            <div class="est-det-larga"><small>Últimas compras</small><${Historico} p=${p} /></div>
            ${p.m4u_comprar ? html`<div><small>Necessidade de compra no market4u</small>${num(p.m4u_comprar)} un (pelo planograma)</div>` : null}
          </div>
        </td></tr>` : null}
      <//>`)}</tbody>
    </table></div>
    ${lista.length > limite ? html`<button class="vd-link db-mais" onClick=${() => setLimite(l => l + 200)}>Mostrar mais (${lista.length - limite} restantes)</button>` : null}
    ${!lista.length ? html`<div class="vd-muted db-vazio">Nada com esses filtros.</div>` : null}
  </div>`;
}

// ---------- lista de compras ----------
function textoWhats(itens, info, porPreco) {
  const hoje = new Date();
  let tot = 0;
  const linhas = itens.map(it => {
    const p = info[it.chave];
    const ult = p && p.ultimo_preco;
    const preco = it.preco_hoje || ult;
    if (preco) tot += preco * it.qtd;
    let l = `${it.ok ? '✅' : '▫️'} ${num(it.qtd)}× ${it.nome}`;
    if (ult) l += ` — últ. ${brl(ult)}${p.ultima_compra ? ' (' + br(p.ultima_compra) + ')' : ''}`;
    if (it.obs) l += ` — ${it.obs}`;
    return l;
  });
  return `🛒 *Lista de compras — ${two(hoje.getDate())}/${two(hoje.getMonth() + 1)}*\n\n` + linhas.join('\n') +
    `\n\n${itens.length} itens · estimado ${brl(tot)}` + (porPreco ? '' : '\n_(preços = última compra)_');
}

function ListaCompras({ d, lista, setLista, onToast, onConfig }) {
  const info = useMemo(() => Object.fromEntries(d.produtos.map(p => [p.chave, p])), [d]);
  const [novo, setNovo] = useState('');
  const [dias, setDias] = useState(d.config.dias_cobertura);
  useEffect(() => setDias(d.config.dias_cobertura), [d.config.dias_cobertura]);
  const naLista = new Set(lista.map(i => i.chave));
  const sugestoes = d.produtos.filter(p => p.sugestao > 0 && !naLista.has(p.chave) && ['acabou', 'critico', 'acabando'].includes(p.status));
  const outrasSug = d.produtos.filter(p => p.sugestao > 0 && !naLista.has(p.chave) && !['acabou', 'critico', 'acabando'].includes(p.status));
  const add = (ps) => setLista(l => [...l, ...ps.map(p => ({ chave: p.chave, nome: p.nome, qtd: p.sugestao || 1, ok: false, preco_hoje: null, obs: '' }))]);
  const mudar = (i, campo, v) => setLista(l => l.map((x, j) => j === i ? { ...x, [campo]: v } : x));
  const tirar = i => setLista(l => l.filter((_, j) => j !== i));
  let total = 0, totalHoje = 0, temHoje = false;
  for (const it of lista) { const p = info[it.chave]; const u = p?.ultimo_preco || p?.custo || 0; total += u * it.qtd; if (it.preco_hoje) { temHoje = true; totalHoje += it.preco_hoje * it.qtd; } else totalHoje += u * it.qtd; }
  const whats = () => { window.open('https://wa.me/?text=' + encodeURIComponent(textoWhats(lista, info, temHoje)), '_blank'); };
  const copiar = async () => { try { await navigator.clipboard.writeText(textoWhats(lista, info, temHoje)); onToast('Lista copiada — é só colar no WhatsApp'); } catch { onToast('Não deu para copiar neste navegador'); } };
  const addManual = () => { const n = novo.trim(); if (!n) return; setLista(l => [...l, { chave: 'm:' + Date.now(), nome: n, qtd: 1, ok: false, preco_hoje: null, obs: '', manual: true }]); setNovo(''); };

  return html`<div class="est-lc">
    <section class="db-card">
      <header><div><h3>Sugestões de compra</h3><small>vão acabar antes de ${d.config.dias_cobertura} dias, pelo que vende por dia (últimos ${d.config.dias_giro} dias)</small></div>
        <label class="est-dias">Comprar para <input type="number" min="1" max="90" value=${dias} onInput=${e => setDias(e.target.value)} onBlur=${() => dias != d.config.dias_cobertura && onConfig({ dias_cobertura: +dias })}
          onKeyDown=${e => e.key === 'Enter' && e.target.blur()} /> dias</label></header>
      ${sugestoes.length ? html`
        <div class="est-sug">${sugestoes.map(p => html`<div key=${p.chave} class="est-sug-it">
          <div><b>${p.nome}</b><small class="vd-muted">${titulo(p.categoria)} · CD ${num(p.cd)} · loja ${num(p.loja)} · vende ${num(p.media_dia, 1)}/dia</small></div>
          <${Status} p=${p} />
          <div class="n"><b>${num(p.sugestao)} un</b><small class="vd-muted">${p.ultimo_preco ? 'últ. ' + brl(p.ultimo_preco) : 'custo ' + brl(p.custo)}</small></div>
          <button class="est-add" onClick=${() => add([p])}>+ lista</button>
        </div>`)}</div>
        <div class="est-acoes"><button class="vd-primary" onClick=${() => add(sugestoes)}>Pôr todas na lista (${sugestoes.length})</button>
          ${outrasSug.length ? html`<span class="vd-muted">+ ${outrasSug.length} produto(s) com estoque para ${d.config.dias_cobertura}+ dias mas abaixo do ideal (prateleira cheia)</span>` : null}</div>`
        : html`<div class="vd-muted db-vazio">Nada vai acabar nos próximos ${d.config.dias_cobertura} dias. 🎉</div>`}
      <div class="vd-muted db-nota">Quantidade sugerida = o que vende em ${d.config.dias_cobertura} dias + o necessário para a prateleira da loja ficar cheia, menos o que já tem no CD e na loja.</div>
    </section>

    <section class="db-card">
      <header><div><h3>Lista de compras</h3><small>${lista.length} itens · fica salva no notebook (vale no celular também)</small></div>
        <div class="est-acoes">
          <button class="est-whats" onClick=${whats} disabled=${!lista.length}>WhatsApp</button>
          <button class="iconbtn" style=${{ width: 'auto', padding: '0 10px', fontSize: '12.5px' }} onClick=${copiar} disabled=${!lista.length}>Copiar texto</button>
          ${lista.some(i => i.ok) ? html`<button class="vd-link" onClick=${() => setLista(l => l.filter(i => !i.ok))}>Tirar os comprados</button>` : null}
          ${lista.length ? html`<button class="vd-link" onClick=${() => confirm('Apagar a lista inteira?') && setLista([])}>Limpar</button>` : null}
        </div></header>
      ${lista.length ? html`<div class="est-lista">${lista.map((it, i) => {
        const p = info[it.chave];
        const cmp = comparaPreco(it.preco_hoje, p);
        return html`<div key=${it.chave} class=${'est-li' + (it.ok ? ' ok' : '')}>
          <input type="checkbox" checked=${it.ok} onChange=${e => mudar(i, 'ok', e.target.checked)} title="Comprado" />
          <div class="est-li-nome"><b>${it.nome}</b>
            ${p ? html`<small class="vd-muted">CD ${num(p.cd)} · loja ${num(p.loja)} · vende ${num(p.media_dia, 1)}/dia${p.fornecedor ? ' · ' + p.fornecedor : ''}</small>` : html`<small class="vd-muted">item avulso</small>`}
            ${p && p.ultimo_preco ? html`<small class="est-precos">Última compra <b>${brl(p.ultimo_preco)}</b> (${br(p.ultima_compra)})${p.preco_anterior ? html` · antes ${brl(p.preco_anterior)}` : null}${p.preco_medio ? html` · média ${brl(p.preco_medio)} · mín ${brl(p.preco_min)} · máx ${brl(p.preco_max)}` : null}</small>`
              : p ? html`<small class="est-precos">Sem compra registrada · custo no cadastro ${brl(p.custo)}</small>` : null}
          </div>
          <div class="est-qtd">
            <button onClick=${() => mudar(i, 'qtd', Math.max(0, it.qtd - 1))}>−</button>
            <input type="number" min="0" value=${it.qtd} onInput=${e => mudar(i, 'qtd', Math.max(0, +e.target.value || 0))} />
            <button onClick=${() => mudar(i, 'qtd', it.qtd + 1)}>+</button>
          </div>
          <div class="est-hoje">
            <input type="number" step="0.01" min="0" placeholder="preço hoje" value=${it.preco_hoje ?? ''} onInput=${e => mudar(i, 'preco_hoje', e.target.value === '' ? null : +e.target.value)} />
            ${cmp ? html`<span class=${'est-cmp ' + cmp.cls} title=${cmp.vu != null ? `vs última compra: ${cmp.vu > 0 ? '+' : ''}${num(cmp.vu, 1)}%` : ''}>${cmp.txt} (${cmp.v > 0 ? '+' : ''}${num(cmp.v, 0)}% da média)</span>` : null}
          </div>
          <button class="est-x" title="Tirar da lista" onClick=${() => tirar(i)}>✕</button>
        </div>`;
      })}</div>
        <div class="est-total">Estimado pela última compra: <b>${brl(total)}</b>${temHoje ? html` · com os preços de hoje: <b>${brl(totalHoje)}</b>` : null}</div>`
        : html`<div class="vd-muted db-vazio">A lista está vazia. Use as sugestões acima ou "+ lista" na aba Estoque.</div>`}
      <div class="est-novo"><input placeholder="Adicionar item avulso (ex.: sacolas, gelo…)" value=${novo} onInput=${e => setNovo(e.target.value)} onKeyDown=${e => e.key === 'Enter' && addManual()} />
        <button class="iconbtn" style=${{ width: 'auto', padding: '0 12px' }} onClick=${addManual}>Adicionar</button></div>
      <div class="vd-muted db-nota">No mercado: digite o "preço hoje" e o painel diz se está barato ou caro comparando com o que vocês já pagaram.</div>
    </section>
  </div>`;
}

// ---------- tela ----------
export function EstoqueView({ onExit, extraButtons, onToast, onAbrirVendas }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [vista, setVista] = useState(() => { try { return localStorage.getItem('est_vista') || 'estoque'; } catch { return 'estoque'; } });
  const [lista, setListaLocal] = useState([]);
  const salvarT = useRef(null);
  const [, tick] = useState(0);

  const carregar = async () => {
    try { const r = await api('/api/estoque?_=' + Date.now()); setD(r); setErr(''); return r; }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { carregar().then(r => r && setListaLocal(r.lista?.itens || [])); }, []);
  // pega atualizações automáticas do servidor (e mudanças da lista feitas em outro aparelho)
  useEffect(() => {
    const id = setInterval(async () => {
      const r = await carregar();
      tick(x => x + 1);
      if (r && !salvarT.current && r.lista && JSON.stringify(r.lista.itens) !== JSON.stringify(lista)) setListaLocal(r.lista.itens || []);
    }, 60000);
    return () => clearInterval(id);
  }, [lista]);
  const setLista = (fn) => setListaLocal(l => {
    const n = typeof fn === 'function' ? fn(l) : fn;
    clearTimeout(salvarT.current);
    salvarT.current = setTimeout(() => { salvarT.current = null; api('/api/estoque/lista', { json: { itens: n } }).catch(e => onToast('Não salvou a lista: ' + e.message)); }, 600);
    return n;
  });
  const atualizar = async () => {
    setBusy(true);
    try { const r = await api('/api/estoque/atualizar', { json: {} }); setD(r); if (r.erro_atualizar) setErr(r.erro_atualizar); else { setErr(''); onToast('Estoque atualizado'); } }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const config = async (c) => { try { await api('/api/estoque/config', { json: c }); await carregar(); onToast('Configuração salva'); } catch (e) { onToast('Erro: ' + e.message); } };
  const escolher = v => { setVista(v); try { localStorage.setItem('est_vista', v); } catch {} };
  const add = p => setLista(l => l.some(x => x.chave === p.chave) ? l : [...l, { chave: p.chave, nome: p.nome, qtd: p.sugestao || 1, ok: false, preco_hoje: null, obs: '' }]);
  const est = d?.estado || {};
  const naLista = new Set(lista.map(i => i.chave));
  const precisaLogin = /conect|sessão|login/i.test(err || est.erro || '');

  return html`<div class="db-root">
    <div class="topbar">
      <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>✕</button>
      <div class="brand"><h1>Estoque</h1><small>${est.atualizando ? 'atualizando…' : 'atualizado ' + ha(est.atualizado_em)}${est.proxima && !est.atualizando ? ' · próxima ' + em(est.proxima) : ''}</small></div>
      <div class="seg">
        <button class=${vista === 'estoque' ? 'on' : ''} onClick=${() => escolher('estoque')}>CD e loja</button>
        <button class=${vista === 'lista' ? 'on' : ''} onClick=${() => escolher('lista')}>Lista de compras${lista.length ? ` (${lista.length})` : ''}</button>
      </div>
      <button class="iconbtn" title="Baixar o estoque do market4u agora" onClick=${atualizar} disabled=${busy || est.atualizando} style=${{ width: 'auto', padding: '0 12px', fontSize: '12.5px' }}>${busy ? 'Atualizando…' : '↻ Atualizar agora'}</button>
      ${d ? html`<label class="est-int" title="De quanto em quanto tempo o painel baixa o estoque sozinho">a cada
        <select value=${d.config.intervalo_min} onChange=${e => config({ intervalo_min: +e.target.value })}>
          ${[10, 15, 30, 60, 120, 240].map(m => html`<option key=${m} value=${m}>${m < 60 ? m + ' min' : m / 60 + ' h'}</option>`)}
        </select></label>` : null}
      <div class="spacer"></div>
      ${extraButtons || null}
    </div>
    <div class="db-corpo"><div class="db-conteudo">
      ${err || est.erro ? html`<div class="db-aviso">${err || est.erro}${precisaLogin && onAbrirVendas ? html` <button class="vd-link" onClick=${onAbrirVendas}>Conectar em Vendas</button>` : null}</div>` : null}
      ${!d ? html`<div class="vd-empty"><div class="spin"></div><span>Carregando…</span></div>`
        : d.vazio ? html`<div class="vd-empty"><span>O estoque ainda não foi baixado do market4u.</span><button class="vd-primary" onClick=${atualizar} disabled=${busy}>${busy ? 'Baixando…' : 'Baixar agora'}</button></div>`
        : vista === 'estoque' ? html`<${VisaoEstoque} d=${d} naLista=${naLista} onAdd=${p => { add(p); onToast(p.nome + ' na lista'); }} />`
        : html`<${ListaCompras} d=${d} lista=${lista} setLista=${setLista} onToast=${onToast} onConfig=${config} />`}
    </div></div>
  </div>`;
}
