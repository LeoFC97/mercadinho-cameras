// dashboard.js — Dashboard de vendas (BI): indicadores do período comparados com o período anterior,
// faturamento por dia, mapa de calor dia × hora, categorias, produtos (curva ABC), pagamentos,
// produtos tirados do carrinho e clientes identificados. Dados: /api/bi (planilhas do market4u).
import { api, two } from './comum.js';
const { useState, useEffect, useMemo, useRef, useLayoutEffect } = React;
const html = htm.bind(React.createElement);

// ---------- formatos ----------
const brl = v => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl0 = v => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const num = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = v => v == null ? '—' : num(v, 1) + '%';
const iso = d => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const deIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const br = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '';
const DSEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const variacao = (a, b) => (b == null || a == null || !b) ? null : (a - b) / Math.abs(b) * 100;
const titulo = s => (s || '').toLowerCase().replace(/(^|\s|\/)\S/g, c => c.toUpperCase());

function periodo(preset) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const menos = n => { const d = new Date(hoje); d.setDate(d.getDate() - n); return d; };
  if (preset === '7') return [menos(6), hoje];
  if (preset === '30') return [menos(29), hoje];
  if (preset === '90') return [menos(89), hoje];
  if (preset === 'mes') return [new Date(hoje.getFullYear(), hoje.getMonth(), 1), hoje];
  if (preset === 'mespass') return [new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1), new Date(hoje.getFullYear(), hoje.getMonth(), 0)];
  return [menos(29), hoje];
}
const PRESETS = [['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['mes', 'Este mês'], ['mespass', 'Mês passado']];

// largura do elemento (para os gráficos SVG ficarem nítidos)
function useLargura() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(e => setW(Math.max(260, Math.floor(e[0].contentRect.width))));
    ro.observe(ref.current); return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// dica flutuante única
function useDica() {
  const [d, setD] = useState(null);
  const mostrar = (e, conteudo) => setD({ x: e.clientX, y: e.clientY, c: conteudo });
  const esconder = () => setD(null);
  const el = d ? html`<div class="db-dica" style=${{ left: Math.min(d.x + 14, window.innerWidth - 250) + 'px', top: (d.y + 14) + 'px' }}>${d.c}</div>` : null;
  return [mostrar, esconder, el];
}

function Delta({ atual, anterior, inverso, sufixo }) {
  const v = variacao(atual, anterior);
  if (v == null) return html`<span class="db-delta neutro">sem comparação</span>`;
  if (Math.abs(v) < 0.5) return html`<span class="db-delta neutro">= estável</span>`;
  const bom = inverso ? v < 0 : v > 0;
  return html`<span class=${'db-delta ' + (bom ? 'bom' : 'ruim')} title="Em relação ao período anterior de mesmo tamanho">
    ${v > 0 ? '▲' : '▼'} ${num(Math.abs(v), Math.abs(v) < 10 ? 1 : 0)}%${sufixo || ''}</span>`;
}

function Kpi({ rot, valor, sub, atual, anterior, inverso, dica }) {
  return html`<div class="db-kpi" title=${dica || ''}>
    <small>${rot}</small>
    <b>${valor}</b>
    <div class="db-kpi-pe">${atual !== undefined && atual !== null ? html`<${Delta} atual=${atual} anterior=${anterior} inverso=${inverso} />` : null}${sub ? html`<span class="db-kpi-sub">${sub}</span>` : null}</div>
  </div>`;
}

// ---------- faturamento por dia ----------
function GraficoDias({ dias, anteriores, dica }) {
  const [ref, w] = useLargura();
  const [hover, setHover] = useState(null);
  const h = 230, pl = 58, pr = 12, pt = 14, pb = 28;
  const iw = w - pl - pr, ih = h - pt - pb;
  const max = Math.max(1, ...dias.map(d => d.faturamento), ...(anteriores || []).map(d => d.faturamento));
  const passo = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].find(s => max / s <= 4) || 20000;
  const topo = Math.ceil(max / passo) * passo;
  const y = v => pt + ih - v / topo * ih;
  const bw = iw / dias.length;
  const barW = Math.max(2, Math.min(28, bw - 2));
  const ticks = []; for (let v = 0; v <= topo; v += passo) ticks.push(v);
  const cadaN = Math.ceil(dias.length / Math.max(1, Math.floor(iw / 46)));
  const linhaAnt = anteriores && anteriores.length === dias.length
    ? anteriores.map((d, i) => `${i ? 'L' : 'M'}${(pl + i * bw + bw / 2).toFixed(1)},${y(d.faturamento).toFixed(1)}`).join(' ') : null;
  const mover = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - pl) / bw);
    if (i < 0 || i >= dias.length) { setHover(null); dica.esconder(); return; }
    setHover(i);
    const d = dias[i], a = anteriores && anteriores[i];
    const dt = deIso(d.dia);
    dica.mostrar(e, html`<div><b>${DSEM[dt.getDay()]} ${br(d.dia)}</b></div>
      <div>Faturamento: <b>${brl(d.faturamento)}</b></div>
      <div>${d.compras} compras · ticket ${d.compras ? brl(d.faturamento / d.compras) : '—'}</div>
      <div>Margem: ${brl(d.margem)}</div>
      ${a ? html`<div class="db-dica-ant">Período anterior (${br(a.dia)}): ${brl(a.faturamento)}</div>` : null}`);
  };
  return html`<div ref=${ref} class="db-chart">
    <svg width=${w} height=${h} onMouseMove=${mover} onMouseLeave=${() => { setHover(null); dica.esconder(); }}>
      ${ticks.map(v => html`<g key=${v}><line x1=${pl} x2=${w - pr} y1=${y(v)} y2=${y(v)} class="db-grid" />
        <text x=${pl - 8} y=${y(v) + 4} class="db-eixo" text-anchor="end">${v >= 1000 ? num(v / 1000, v % 1000 ? 1 : 0) + ' mil' : num(v)}</text></g>`)}
      ${dias.map((d, i) => {
        const x = pl + i * bw + (bw - barW) / 2, yy = y(d.faturamento), hh = pt + ih - yy;
        const dt = deIso(d.dia), fds = dt.getDay() === 0 || dt.getDay() === 6;
        return html`<g key=${d.dia}>
          ${hover === i ? html`<rect x=${pl + i * bw} y=${pt} width=${bw} height=${ih} class="db-hover" />` : null}
          ${hh > 0 ? html`<path d=${`M${x},${pt + ih} V${yy + Math.min(4, hh)} Q${x},${yy} ${x + Math.min(4, barW / 2)},${yy} H${x + barW - Math.min(4, barW / 2)} Q${x + barW},${yy} ${x + barW},${yy + Math.min(4, hh)} V${pt + ih} Z`}
            class=${'db-barra' + (fds ? ' fds' : '')} />` : null}
          ${i % cadaN === 0 ? html`<text x=${pl + i * bw + bw / 2} y=${h - 9} class="db-eixo" text-anchor="middle">${dias.length <= 14 ? DSEM[dt.getDay()] + ' ' : ''}${br(d.dia)}</text>` : null}
        </g>`;
      })}
      ${linhaAnt ? html`<path d=${linhaAnt} class="db-linha-ant" />` : null}
      <line x1=${pl} x2=${w - pr} y1=${pt + ih} y2=${pt + ih} class="db-base" />
    </svg>
    <div class="db-legenda">
      <span><i class="db-sw barra"></i>Este período</span>
      <span><i class="db-sw barra fds"></i>Fim de semana</span>
      ${linhaAnt ? html`<span><i class="db-sw linha"></i>Período anterior (mesmo dia da sequência)</span>` : null}
    </div>
  </div>`;
}

// ---------- mapa de calor dia × hora ----------
const RAMPA = ['#1b2432', '#13335a', '#104281', '#1c5cab', '#2a78d6', '#5598e7', '#9ec5f4'];
function MapaCalor({ hm, dica }) {
  const [medida, setMedida] = useState('compras');
  const [ref, w] = useLargura();
  const ordem = [0, 1, 2, 3, 4, 5, 6];   // seg..dom (como vem do servidor)
  const m = hm[medida];
  const max = Math.max(1, ...m.flat());
  const lw = 40, top = 18, cw = Math.max(9, (w - lw) / 24), ch = 24;
  const cor = v => v <= 0 ? RAMPA[0] : RAMPA[Math.min(RAMPA.length - 1, 1 + Math.floor(v / max * (RAMPA.length - 1.001)))];
  const nomes = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
  return html`<div>
    <div class="db-mini-seg seg">
      <button class=${medida === 'compras' ? 'on' : ''} onClick=${() => setMedida('compras')}>Compras</button>
      <button class=${medida === 'faturamento' ? 'on' : ''} onClick=${() => setMedida('faturamento')}>Faturamento</button>
    </div>
    <div ref=${ref} class="db-chart">
      <svg width=${w} height=${top + 7 * ch + 4} onMouseLeave=${dica.esconder}>
        ${Array.from({ length: 24 }, (_, hh) => hh % 3 === 0 ? html`<text key=${'h' + hh} x=${lw + hh * cw + cw / 2} y=${12} class="db-eixo" text-anchor="middle">${hh}h</text>` : null)}
        ${ordem.map((d, r) => html`<g key=${d}>
          <text x=${lw - 8} y=${top + r * ch + ch / 2 + 4} class="db-eixo" text-anchor="end">${hm.dias[d]}</text>
          ${m[d].map((v, hh) => html`<rect key=${hh} x=${lw + hh * cw + 1} y=${top + r * ch + 1} width=${cw - 2} height=${ch - 2} rx="3" fill=${cor(v)}
            onMouseMove=${e => dica.mostrar(e, html`<div><b>${nomes[d]}, ${hh}h–${hh + 1}h</b></div>
              <div>${hm.compras[d][hh]} compras · ${brl(hm.faturamento[d][hh])}</div>
              <div class="db-dica-ant">média de ${num(hm.compras[d][hh] / Math.max(1, hm.ocorrencias[d]), 1)} compras por ${nomes[d]}</div>`)} />`)}
        </g>`)}
      </svg>
      <div class="db-legenda"><span>menos</span>${RAMPA.slice(1).map(c => html`<i key=${c} class="db-sw" style=${{ background: c }}></i>`)}<span>mais ${medida === 'compras' ? 'compras' : 'faturamento'}</span></div>
    </div>
  </div>`;
}

// ---------- barras horizontais ----------
function Barras({ itens, valor, rotulo, extra, dica, fmt, max: maxFixo, cor }) {
  const max = maxFixo || Math.max(1, ...itens.map(valor));
  const total = itens.reduce((a, i) => a + valor(i), 0) || 1;
  return html`<div class="db-barras">${itens.map((it, n) => html`<div class="db-bl" key=${n}
      onMouseMove=${dica ? (e => dica.mostrar(e, dica.conteudo(it))) : null} onMouseLeave=${dica ? dica.esconder : null}>
      <div class="db-bl-top"><span class="db-bl-nome" title=${rotulo(it)}>${rotulo(it)}</span>
        <span class="db-bl-val">${(fmt || brl)(valor(it))}<small> · ${num(valor(it) / total * 100, 0)}%</small></span></div>
      <div class="db-bl-trilho"><div class="db-bl-barra" style=${{ width: Math.max(0.5, valor(it) / max * 100) + '%', background: cor || null }}></div></div>
      ${extra ? html`<div class="db-bl-extra">${extra(it)}</div>` : null}
    </div>`)}</div>`;
}

function Card({ titulo: t, sub, children, acoes, cls }) {
  return html`<section class=${'db-card ' + (cls || '')}>
    <header><div><h3>${t}</h3>${sub ? html`<small>${sub}</small>` : null}</div>${acoes || null}</header>
    ${children}
  </section>`;
}

// ---------- tabela de produtos ----------
const COLS = [
  ['nome', 'Produto', 'txt'], ['qtd', 'Qtd', 'n'], ['faturamento', 'Faturamento', 'r'], ['margem_pct', 'Margem', 'p'],
  ['var', 'vs anterior', 'v'], ['removidos', 'Tirados do carrinho', 'n'], ['abc', 'ABC', 'txt'],
];
function TabelaProdutos({ produtos }) {
  const [ord, setOrd] = useState(['faturamento', -1]);
  const [q, setQ] = useState('');
  const [todos, setTodos] = useState(false);
  const linhas = useMemo(() => {
    let l = produtos.map(p => ({ ...p, var: variacao(p.faturamento, p.anterior) }));
    if (q) { const s = q.toLowerCase(); l = l.filter(p => (p.nome + ' ' + p.categoria + ' ' + p.fabricante + ' ' + p.codigo).toLowerCase().includes(s)); }
    const [k, dir] = ord;
    l.sort((a, b) => { const x = a[k], y = b[k]; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
    return l;
  }, [produtos, ord, q]);
  const csv = () => {
    const cab = ['Código', 'Produto', 'Categoria', 'Fabricante', 'Qtd', 'Faturamento', 'Margem R$', 'Margem %', 'Faturamento período anterior', 'Removidos do carrinho', 'ABC'];
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const f = v => v == null ? '' : String(v).replace('.', ',');
    const txt = [cab.map(esc).join(';')].concat(linhas.map(p => [p.codigo, p.nome, p.categoria, p.fabricante, f(p.qtd), f(p.faturamento), f(p.margem), f(p.margem_pct), f(p.anterior), p.removidos, p.abc].map(esc).join(';'))).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + txt], { type: 'text/csv' })); a.download = 'produtos.csv'; a.click();
  };
  const mostrar = todos ? linhas : linhas.slice(0, 25);
  return html`<div>
    <div class="db-tab-bar">
      <input class="db-busca" placeholder="Filtrar produto, categoria, fabricante…" value=${q} onInput=${e => setQ(e.target.value)} />
      <button class="vd-link" onClick=${csv}>⬇ Baixar CSV</button>
    </div>
    <div class="db-tab-wrap"><table class="db-tab">
      <thead><tr>${COLS.map(([k, r, t]) => html`<th key=${k} class=${t !== 'txt' ? 'n' : ''} onClick=${() => setOrd(o => [k, o[0] === k ? -o[1] : (t === 'txt' ? 1 : -1)])}>
        ${r}${ord[0] === k ? (ord[1] < 0 ? ' ↓' : ' ↑') : ''}</th>`)}</tr></thead>
      <tbody>${mostrar.map(p => html`<tr key=${p.codigo}>
        <td><div class="db-pnome">${p.nome}</div><small class="vd-muted">${titulo(p.categoria)}${p.fabricante ? ' · ' + p.fabricante : ''}</small></td>
        <td class="n">${num(p.qtd)}</td>
        <td class="n">${brl(p.faturamento)}</td>
        <td class=${'n' + (p.margem_pct != null && p.margem_pct < 15 ? ' db-ruim' : '')}>${pct(p.margem_pct)}</td>
        <td class="n">${p.anterior ? html`<${Delta} atual=${p.faturamento} anterior=${p.anterior} />` : html`<span class="db-delta novo">novo</span>`}</td>
        <td class="n">${p.removidos || ''}</td>
        <td><span class=${'db-abc ' + p.abc}>${p.abc}</span></td>
      </tr>`)}</tbody>
    </table></div>
    ${linhas.length > 25 ? html`<button class="vd-link db-mais" onClick=${() => setTodos(t => !t)}>${todos ? 'Mostrar só os 25 primeiros' : `Mostrar todos os ${linhas.length} produtos`}</button>` : null}
  </div>`;
}

// ---------- tela ----------
export function DashboardView({ onExit, extraButtons, onAbrirVendas }) {
  const [preset, setPreset] = useState(() => { try { return localStorage.getItem('db_preset') || '30'; } catch { return '30'; } });
  const [custom, setCustom] = useState(null);       // [de, ate] ISO
  const [dados, setDados] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [mostrar, esconder, dicaEl] = useDica();
  const dica = { mostrar, esconder };

  const faixa = custom || periodo(preset).map(iso);
  const carregar = async (silencioso) => {
    if (!silencioso) { setBusy(true); setErr(''); }
    try { setDados(await api(`/api/bi?de=${faixa[0]}&ate=${faixa[1]}&_=${Date.now()}`)); }
    catch (e) { if (!silencioso) setErr(e.message); }
    if (!silencioso) setBusy(false);
  };
  useEffect(() => { carregar(); }, [faixa[0], faixa[1]]);
  // clientes/pagamentos/removidos chegam aos poucos (o market4u é lento nesse relatório): acompanha e recarrega
  const [prog, setProg] = useState(null);
  useEffect(() => {
    if (!dados || !dados.baixando || !dados.baixando.pendentes) { setProg(null); return; }
    let vivo = true, ultimo = dados.baixando.feitos;
    setProg(dados.baixando);
    const id = setInterval(async () => {
      try {
        const p = await api('/api/bi/progresso?_=' + Date.now());
        if (!vivo) return;
        setProg(p);
        if (!p.pendentes || p.feitos - ultimo >= 3) { ultimo = p.feitos; carregar(true); }
      } catch {}
    }, 5000);
    return () => { vivo = false; clearInterval(id); };
  }, [dados]);
  const parcial = dados && dados.dias_com_detalhes < dados.dias_com_dados;
  const subParcial = dados ? (parcial ? ` · parcial: ${dados.dias_com_detalhes} de ${dados.dias_com_dados} dias` : '') : '';
  const escolher = p => { setCustom(null); setPreset(p); try { localStorage.setItem('db_preset', p); } catch {} };

  const k = dados?.kpi, ka = dados?.kpi_anterior;
  const nDias = dados ? dados.dias : 0;
  return html`<div class="db-root">
    <div class="topbar">
      <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>✕</button>
      <div class="brand"><h1>Dashboard de vendas</h1><small>${br(faixa[0])} a ${br(faixa[1])}</small></div>
      <div class="seg">${PRESETS.map(([p, r]) => html`<button key=${p} class=${!custom && preset === p ? 'on' : ''} onClick=${() => escolher(p)}>${r}</button>`)}</div>
      <div class="db-datas">
        <input type="date" value=${faixa[0]} max=${faixa[1]} onChange=${e => e.target.value && setCustom([e.target.value, faixa[1]])} />
        <span>até</span>
        <input type="date" value=${faixa[1]} min=${faixa[0]} max=${iso(new Date())} onChange=${e => e.target.value && setCustom([faixa[0], e.target.value])} />
      </div>
      <button class="iconbtn" title="Atualizar (baixa de novo o dia de hoje)" onClick=${() => carregar()} disabled=${busy} style=${{ width: 'auto', padding: '0 12px', fontSize: '12.5px' }}>${busy ? 'Carregando…' : '↻ Atualizar'}</button>
      <div class="spacer"></div>
      ${extraButtons || null}
    </div>

    <div class="db-corpo">
      ${err ? html`<div class="vd-err">${err}</div>` : null}
      ${dados?.precisa_login ? html`<div class="db-aviso">O market4u pediu login de novo — mostrando só os dias já baixados.
          ${onAbrirVendas ? html` <button class="vd-link" onClick=${onAbrirVendas}>Conectar em Vendas</button>` : null}</div>`
        : dados?.aviso ? html`<div class="db-aviso">Parte dos dados não veio do market4u agora: ${dados.aviso}</div>` : null}
      ${prog && prog.pendentes ? html`<div class="db-aviso db-prog"><span class="spin"></span>
          <span>Baixando clientes, pagamentos e produtos removidos do market4u (é lento: uns 10–15 s por dia) — ${prog.baixando ? 'dia ' + br(prog.baixando) + ', ' : ''}faltam ${prog.pendentes} dia(s).
          Os números de vendas já estão completos; o resto vai aparecendo sozinho. Pode sair desta tela que continua baixando.</span></div>`
        : (dados?.baixando?.erro && parcial ? html`<div class="db-aviso">Não deu para baixar todos os dados de clientes: ${dados.baixando.erro}</div>` : null)}
      ${dados && dados.dias_sem_dados?.length ? html`<div class="db-aviso">Sem planilha para ${dados.dias_sem_dados.length} dia(s) do período (${dados.dias_sem_dados.slice(0, 5).map(br).join(', ')}${dados.dias_sem_dados.length > 5 ? '…' : ''}).</div>` : null}

      ${!dados && busy ? html`<div class="vd-empty"><div class="spin"></div><span>Baixando as vendas do market4u… Na primeira vez pode levar uns 30 segundos; depois fica guardado.</span></div>` : null}

      ${dados ? html`
        <div class=${'db-conteudo' + (busy ? ' carregando' : '')}>
          <div class="db-kpis">
            <${Kpi} rot="Faturamento" valor=${brl0(k.faturamento)} atual=${k.faturamento} anterior=${ka?.faturamento} sub=${'média ' + brl0(k.fat_por_dia) + '/dia'} />
            <${Kpi} rot="Margem bruta" valor=${brl0(k.margem)} atual=${k.margem} anterior=${ka?.margem} sub=${pct(k.margem_pct) + ' do faturamento'} dica="Venda menos custo dos produtos (do cadastro do market4u)" />
            <${Kpi} rot="Compras" valor=${num(k.compras)} atual=${k.compras} anterior=${ka?.compras} sub=${num(k.compras / Math.max(1, nDias), 1) + '/dia'} />
            <${Kpi} rot="Ticket médio" valor=${brl(k.ticket_medio)} atual=${k.ticket_medio} anterior=${ka?.ticket_medio} sub=${num(k.itens_por_compra, 1) + ' itens por compra'} />
            <${Kpi} rot="Com CPF na nota" valor=${pct(k.pct_identificadas)} atual=${k.pct_identificadas} anterior=${ka?.pct_identificadas} sub=${k.clientes_identificados == null ? 'baixando…' : k.clientes_identificados + ' clientes diferentes' + subParcial} />
            <${Kpi} rot="Compras desistidas" valor=${num(k.compras_removidas)} atual=${k.compras_removidas} anterior=${ka?.compras_removidas} inverso=${true} sub=${k.compras_removidas == null ? 'baixando…' : pct(k.taxa_desistencia) + ' das tentativas' + subParcial} dica="Transações do tipo 'Compra removida' (a pessoa começou e tirou tudo)" />
            <${Kpi} rot="Tirados do carrinho" valor=${num(k.produtos_removidos)} atual=${k.produtos_removidos} anterior=${ka?.produtos_removidos} inverso=${true} sub=${k.produtos_removidos == null ? 'baixando…' : 'devolvidos à prateleira' + subParcial} />
          </div>

          ${dados.insights?.length ? html`<${Card} titulo="O que chama atenção" sub=${'comparando com ' + br(dados.anterior.de) + ' a ' + br(dados.anterior.ate)} cls="db-span2">
            <ul class="db-ins">${dados.insights.map((i, n) => html`<li key=${n} class=${i.tipo}><span>${i.tipo === 'bom' ? '▲' : i.tipo === 'ruim' ? '▼' : '•'}</span>${i.txt}</li>`)}</ul>
          <//>` : null}

          <div class="db-grade">
            <${Card} titulo="Faturamento por dia" sub="passe o mouse para ver o dia" cls="db-span2">
              <${GraficoDias} dias=${dados.por_dia} anteriores=${dados.por_dia_anterior} dica=${dica} />
            <//>
            <${Card} titulo="Quando as pessoas compram" sub="dia da semana × hora, soma do período">
              <${MapaCalor} hm=${dados.heatmap} dica=${dica} />
            <//>
            <${Card} titulo="Categorias" sub="faturamento · margem · variação">
              <${Barras} itens=${dados.categorias.slice(0, 10)} valor=${c => c.faturamento} rotulo=${c => titulo(c.nome)}
                extra=${c => html`<span>margem ${pct(c.margem_pct)}</span> <${Delta} atual=${c.faturamento} anterior=${c.anterior} />`} />
            <//>
            <${Card} titulo="Formas de pagamento" sub=${'compras concluídas' + subParcial}>
              ${!dados.pagamentos.length ? html`<div class="vd-muted">${prog?.pendentes ? 'Baixando…' : 'Sem dados de pagamento no período.'}</div>` : null}
              <${Barras} itens=${dados.pagamentos} valor=${p => p.total} rotulo=${p => p.nome}
                extra=${p => html`<span>${p.compras} compras · ticket ${brl(p.total / Math.max(1, p.compras))}</span>`} />
              ${dados.canais.length > 1 ? html`<div class="db-sep"></div><${Barras} itens=${dados.canais} valor=${p => p.total} rotulo=${p => p.nome === 'POS' ? 'Maquininha (POS)' : p.nome === 'APP' ? 'App market4u' : p.nome} />` : null}
            <//>
            <${Card} titulo="Curva ABC" sub="quais produtos fazem o faturamento">
              <div class="db-abc-res">${['A', 'B', 'C'].map(c => html`<div key=${c}><span class=${'db-abc ' + c}>${c}</span>
                <b>${dados.abc[c].produtos}</b><small>produtos</small><small>${brl0(dados.abc[c].faturamento)} (${num(dados.abc[c].faturamento / Math.max(1, k.faturamento) * 100)}%)</small></div>`)}</div>
              <div class="vd-muted db-nota">A = os que somam 80% do faturamento (não podem faltar) · B = os próximos 15% · C = o resto.</div>
              ${dados.sumiram?.length ? html`<div class="db-sep"></div><div class="db-sub">Venderam no período anterior e nada agora</div>
                <ul class="db-lista">${dados.sumiram.slice(0, 8).map(s => html`<li key=${s.codigo}><span>${s.nome}</span><small>${num(s.anterior_qtd)} un · ${brl(s.anterior)}</small></li>`)}</ul>` : null}
            <//>
            <${Card} titulo="Mais tirados do carrinho" sub=${'pegou e devolveu — pode ser preço ou validade' + subParcial}>
              ${dados.removidos.length ? html`<${Barras} itens=${dados.removidos.slice(0, 10)} valor=${r => r.removidos} rotulo=${r => r.nome} fmt=${v => num(v) + '×'} cor="#d95926"
                extra=${r => html`<span>${num(r.vendidos)} vendidos · tirado em ${r.taxa ?? '—'}% das vezes</span>`} />` : html`<div class="vd-muted">${!dados.dias_com_detalhes ? 'Baixando…' : 'Nenhum produto removido no período.'}</div>`}
            <//>
            <${Card} titulo="Clientes identificados" sub=${'quem pôs CPF na nota' + subParcial}>
              <div class="db-cli-res">
                <div><b>${dados.clientes_resumo.ativos}</b><small>compraram</small></div>
                <div><b>${dados.clientes_resumo.voltaram}</b><small>já tinham comprado antes</small></div>
                <div><b>${dados.clientes_resumo.novos_no_periodo}</b><small>novos neste período</small></div>
                <div><b>${dados.clientes_resumo.nao_voltaram}</b><small>sumiram</small></div>
              </div>
              ${dados.clientes.length ? html`<table class="db-tab db-tab-cli"><thead><tr><th>Cliente</th><th class="n">Compras</th><th class="n">Gasto</th><th class="n">Última</th></tr></thead>
                <tbody>${dados.clientes.slice(0, 10).map(c => html`<tr key=${c.id}><td>${c.nome}</td><td class="n">${c.compras}</td><td class="n">${brl(c.gasto)}</td><td class="n">${br(c.ultima)}</td></tr>`)}</tbody></table>` : null}
              ${dados.perfil.faixa.length || dados.perfil.sexo.length ? html`<div class="db-sep"></div><div class="db-sub">Perfil (compras com cadastro)</div>
                <div class="db-perfil">
                  ${dados.perfil.sexo.length ? html`<${Barras} itens=${dados.perfil.sexo} valor=${s => s.compras} rotulo=${s => s.nome} fmt=${v => num(v)} />` : null}
                  ${dados.perfil.faixa.length ? html`<${Barras} itens=${dados.perfil.faixa} valor=${s => s.compras} rotulo=${s => s.nome + ' anos'} fmt=${v => num(v)} />` : null}
                </div>` : null}
            <//>
            <${Card} titulo="Produtos" sub=${dados.produtos.length + ' produtos vendidos · clique no título da coluna para ordenar'} cls="db-span2">
              <${TabelaProdutos} produtos=${dados.produtos} />
            <//>
          </div>
        </div>` : null}
    </div>
    ${dicaEl}
  </div>`;
}
