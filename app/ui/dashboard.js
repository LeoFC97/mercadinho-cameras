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
const ABAS = [['geral', 'Visão geral'], ['produtos', 'Produtos'], ['clientes', 'Clientes'], ['operacao', 'Pagamentos e carrinho']];
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
function GraficoDias({ dias, anteriores, dica, metrica = 'faturamento' }) {
  const [ref, w] = useLargura();
  const [hover, setHover] = useState(null);
  const [mmOn, setMmOn] = useState(true);
  const mm = dias.map((d, i) => { const j = dias.slice(Math.max(0, i - 6), i + 1); return j.length < 3 ? null : j.reduce((a, x) => a + x.faturamento, 0) / j.length; });
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
      ${mm[i] != null ? html`<div>Média 7 dias: ${brl(mm[i])}</div>` : null}
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
      ${mmOn && dias.length >= 10 ? html`<path class="db-linha-mm" d=${mm.map((v, i) => v == null ? '' : `${mm[i - 1] == null ? 'M' : 'L'}${(pl + i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />` : null}
      <line x1=${pl} x2=${w - pr} y1=${pt + ih} y2=${pt + ih} class="db-base" />
    </svg>
    <div class="db-legenda">
      <span><i class="db-sw barra"></i>Este período</span>
      <span><i class="db-sw barra fds"></i>Fim de semana</span>
      ${linhaAnt ? html`<span><i class="db-sw linha"></i>Período anterior (mesmo dia da sequência)</span>` : null}
      ${dias.length >= 10 ? html`<label class="db-chk"><input type="checkbox" checked=${mmOn} onChange=${e => setMmOn(e.target.checked)} /><i class="db-sw linha-mm"></i>Média móvel de 7 dias</label>` : null}
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


// ---------- colunas verticais (dias da semana, horas, distribuições) ----------
function Colunas({ itens, valor, rotulo, fmt, dica, conteudo, altura = 170, cor, rotuloCada = 1, destaque }) {
  const [ref, w] = useLargura();
  const h = altura, pl = 8, pr = 8, pt = 18, pb = 24;
  const iw = w - pl - pr, ih = h - pt - pb;
  const vals = itens.map(valor);
  const max = Math.max(1e-9, ...vals.map(v => v || 0));
  const bw = iw / Math.max(1, itens.length), barW = Math.max(3, Math.min(42, bw - 4));
  const top = vals.indexOf(Math.max(...vals));
  return html`<div ref=${ref} class="db-chart"><svg width=${w} height=${h} onMouseLeave=${dica && dica.esconder}>
    ${itens.map((it, i) => {
      const v = vals[i] || 0, hh = v / max * ih, x = pl + i * bw + (bw - barW) / 2, yy = pt + ih - hh;
      const r = Math.min(4, barW / 2, hh);
      return html`<g key=${i} onMouseMove=${dica ? (e => dica.mostrar(e, conteudo ? conteudo(it) : html`<b>${rotulo(it)}</b>: ${(fmt || num)(v)}`)) : null}>
        <rect x=${pl + i * bw} y=${pt} width=${bw} height=${ih} fill="transparent" />
        ${hh > 0 ? html`<path d=${`M${x},${pt + ih} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${pt + ih} Z`}
          fill=${cor || '#3987e5'} opacity=${destaque && i !== top ? 0.75 : 1} />` : null}
        ${(destaque && i === top) || itens.length <= 8 ? html`<text x=${x + barW / 2} y=${yy - 5} class="db-eixo db-val" text-anchor="middle">${(fmt || num)(v)}</text>` : null}
        ${i % rotuloCada === 0 ? html`<text x=${pl + i * bw + bw / 2} y=${h - 8} class="db-eixo" text-anchor="middle">${rotulo(it)}</text>` : null}
      </g>`;
    })}
    <line x1=${pl} x2=${w - pr} y1=${pt + ih} y2=${pt + ih} class="db-base" />
  </svg></div>`;
}

// ---------- linhas (acumulado) ----------
function Linhas({ series, rotulos, fmt, dica, altura = 210 }) {
  const [ref, w] = useLargura();
  const [hover, setHover] = useState(null);
  const h = altura, pl = 58, pr = 14, pt = 12, pb = 26;
  const iw = w - pl - pr, ih = h - pt - pb;
  const n = Math.max(...series.map(s => s.valores.length));
  const max = Math.max(1, ...series.flatMap(s => s.valores.filter(v => v != null)));
  const passo = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000].find(s => max / s <= 5) || 250000;
  const topo = Math.ceil(max / passo) * passo;
  const x = i => pl + (n <= 1 ? iw / 2 : i / (n - 1) * iw), y = v => pt + ih - v / topo * ih;
  const ticks = []; for (let v = 0; v <= topo; v += passo) ticks.push(v);
  const cadaN = Math.ceil(n / Math.max(1, Math.floor(iw / 50)));
  const mover = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - pl) / (iw / Math.max(1, n - 1)))));
    setHover(i);
    dica.mostrar(e, html`<div><b>${rotulos[i] || ''}</b></div>${series.map(s => s.valores[i] != null ? html`<div key=${s.nome}><i class="db-sw" style=${{ background: s.cor, verticalAlign: 'middle', marginRight: '6px' }}></i>${s.nome}: <b>${(fmt || brl)(s.valores[i])}</b></div>` : null)}`);
  };
  return html`<div ref=${ref} class="db-chart">
    <svg width=${w} height=${h} onMouseMove=${mover} onMouseLeave=${() => { setHover(null); dica.esconder(); }}>
      ${ticks.map(v => html`<g key=${v}><line x1=${pl} x2=${w - pr} y1=${y(v)} y2=${y(v)} class="db-grid" />
        <text x=${pl - 8} y=${y(v) + 4} class="db-eixo" text-anchor="end">${v >= 1000 ? num(v / 1000, v % 1000 ? 1 : 0) + ' mil' : num(v)}</text></g>`)}
      ${rotulos.map((r, i) => i % cadaN === 0 ? html`<text key=${i} x=${x(i)} y=${h - 8} class="db-eixo" text-anchor="middle">${r}</text>` : null)}
      ${hover != null ? html`<line x1=${x(hover)} x2=${x(hover)} y1=${pt} y2=${pt + ih} class="db-cross" />` : null}
      ${series.map(s => html`<path key=${s.nome} d=${s.valores.map((v, i) => v == null ? '' : `${i && s.valores[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
        fill="none" stroke=${s.cor} stroke-width="2" stroke-dasharray=${s.tracejado ? '5 4' : null} />`)}
      ${hover != null ? series.map(s => s.valores[hover] != null ? html`<circle key=${s.nome} cx=${x(hover)} cy=${y(s.valores[hover])} r="4" fill=${s.cor} stroke="var(--panel)" stroke-width="2" />` : null) : null}
      ${series.slice(0, 1).map(s => { const i = s.valores.length - 1; return s.valores[i] != null ? html`<text key=${'f' + s.nome} x=${Math.min(x(i), w - pr - 4)} y=${y(s.valores[i]) - 8} class="db-eixo db-val" text-anchor="end">${brl0(s.valores[i])}</text>` : null; })}
      <line x1=${pl} x2=${w - pr} y1=${pt + ih} y2=${pt + ih} class="db-base" />
    </svg>
    <div class="db-legenda">${series.map(s => html`<span key=${s.nome}><i class=${'db-sw ' + (s.tracejado ? 'linha' : '')} style=${s.tracejado ? {} : { background: s.cor, height: '3px' }}></i>${s.nome}</span>`)}</div>
  </div>`;
}

// ---------- dispersão: quantidade × margem ----------
const COR_ABC = { A: '#3987e5', B: '#d95926', C: '#199e70' };
function Dispersao({ produtos, dica }) {
  const [ref, w] = useLargura();
  const h = 300, pl = 46, pr = 14, pt = 12, pb = 34;
  const iw = w - pl - pr, ih = h - pt - pb;
  const ps = produtos.filter(p => p.margem_pct != null && p.qtd > 0);
  if (!ps.length) return html`<div class="vd-muted">Sem dados.</div>`;
  const maxQ = Math.max(...ps.map(p => p.qtd)), minQ = Math.min(...ps.map(p => p.qtd));
  const lq = v => Math.log10(v), l0 = lq(Math.max(0.5, minQ / 1.3)), l1 = lq(maxQ * 1.15);
  const xq = v => pl + (lq(Math.max(0.5, v)) - l0) / Math.max(1e-6, l1 - l0) * iw;
  const minM = Math.min(0, ...ps.map(p => p.margem_pct)), maxM = Math.max(60, ...ps.map(p => p.margem_pct));
  const ym = v => pt + ih - (v - minM) / (maxM - minM) * ih;
  const maxF = Math.max(...ps.map(p => p.faturamento));
  const rr = f => 4 + Math.sqrt(f / maxF) * 12;
  const medQ = [...ps].sort((a, b) => a.qtd - b.qtd)[Math.floor(ps.length / 2)].qtd;
  const medM = [...ps].sort((a, b) => a.margem_pct - b.margem_pct)[Math.floor(ps.length / 2)].margem_pct;
  const ticksQ = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].filter(v => lq(v) >= l0 && lq(v) <= l1);
  const ticksM = []; for (let v = Math.ceil(minM / 10) * 10; v <= maxM; v += 10) ticksM.push(v);
  return html`<div ref=${ref} class="db-chart">
    <svg width=${w} height=${h} onMouseLeave=${dica.esconder}>
      ${ticksM.map(v => html`<g key=${'m' + v}><line x1=${pl} x2=${w - pr} y1=${ym(v)} y2=${ym(v)} class="db-grid" /><text x=${pl - 6} y=${ym(v) + 4} class="db-eixo" text-anchor="end">${v}%</text></g>`)}
      ${ticksQ.map(v => html`<text key=${'q' + v} x=${xq(v)} y=${h - 16} class="db-eixo" text-anchor="middle">${v}</text>`)}
      <text x=${pl + iw / 2} y=${h - 2} class="db-eixo" text-anchor="middle">unidades vendidas (escala log) →</text>
      <line x1=${xq(medQ)} x2=${xq(medQ)} y1=${pt} y2=${pt + ih} class="db-cross" />
      <line x1=${pl} x2=${w - pr} y1=${ym(medM)} y2=${ym(medM)} class="db-cross" />
      <text x=${w - pr - 4} y=${pt + 12} class="db-eixo db-quad" text-anchor="end">vende muito · margem boa</text>
      <text x=${w - pr - 4} y=${pt + ih - 6} class="db-eixo db-quad" text-anchor="end">vende muito · margem baixa</text>
      <text x=${pl + 6} y=${pt + 12} class="db-eixo db-quad">vende pouco · margem boa</text>
      <text x=${pl + 6} y=${pt + ih - 6} class="db-eixo db-quad">vende pouco · margem baixa</text>
      ${[...ps].sort((a, b) => b.faturamento - a.faturamento).map(p => html`<circle key=${p.codigo} cx=${xq(p.qtd)} cy=${ym(p.margem_pct)} r=${rr(p.faturamento)}
        fill=${COR_ABC[p.abc]} fill-opacity="0.75" stroke="var(--panel)" stroke-width="2"
        onMouseMove=${e => dica.mostrar(e, html`<div><b>${p.nome}</b></div><div>${num(p.qtd)} un · ${brl(p.faturamento)}</div><div>margem ${pct(p.margem_pct)} · curva ${p.abc}</div>`)} />`)}
    </svg>
    <div class="db-legenda">${['A', 'B', 'C'].map(c => html`<span key=${c}><i class="db-sw" style=${{ background: COR_ABC[c], borderRadius: '50%' }}></i>Curva ${c}</span>`)}<span>tamanho = faturamento · linhas = medianas</span></div>
  </div>`;
}

function Tabela({ colunas, linhas, chave, max = 15 }) {
  const [todos, setTodos] = useState(false);
  const ls = todos ? linhas : linhas.slice(0, max);
  return html`<div class="db-tab-wrap"><table class="db-tab db-tab-cli">
    <thead><tr>${colunas.map(c => html`<th key=${c[0]} class=${c[2] ? 'n' : ''}>${c[0]}</th>`)}</tr></thead>
    <tbody>${ls.map((l, i) => html`<tr key=${chave ? chave(l) : i}>${colunas.map(c => html`<td key=${c[0]} class=${c[2] ? 'n' : ''}>${c[1](l)}</td>`)}</tr>`)}</tbody>
  </table>
  ${linhas.length > max ? html`<button class="vd-link db-mais" onClick=${() => setTodos(t => !t)}>${todos ? 'Mostrar menos' : `Mostrar todos (${linhas.length})`}</button>` : null}</div>`;
}

const Vazio = ({ txt }) => html`<div class="vd-muted db-vazio">${txt}</div>`;
const NOMES_DSEM = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const mesNome = s => { const [y, m] = s.split('-'); return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+m - 1] + '/' + y.slice(2); };

// ---------- abas do dashboard ----------
function AbaGeral({ d, dica, subParcial, prog }) {
  const k = d.kpi, ka = d.kpi_anterior, hm = d.heatmap, pm = d.projecao_mes;
  const semana = NOMES_DSEM.map((n, i) => ({ n, fat: hm.ocorrencias[i] ? hm.faturamento[i].reduce((a, b) => a + b, 0) / hm.ocorrencias[i] : 0,
    compras: hm.ocorrencias[i] ? hm.compras[i].reduce((a, b) => a + b, 0) / hm.ocorrencias[i] : 0, oc: hm.ocorrencias[i] }));
  const horas = Array.from({ length: 24 }, (_, h) => ({ h, compras: hm.compras.reduce((a, r) => a + r[h], 0) / Math.max(1, d.dias_com_dados),
    fat: hm.faturamento.reduce((a, r) => a + r[h], 0) / Math.max(1, d.dias_com_dados), ticket: d.ticket_hora?.[h] }));
  const rot = d.por_dia.map(x => br(x.dia));
  return html`<div class="db-grade">
    ${pm ? html`<${Card} titulo=${'Projeção de ' + mesNome(pm.mes)} sub=${'dia ' + pm.dia + ' de ' + pm.dias_mes}>
      <div class="db-proj">
        <div><small>Até agora</small><b>${brl0(pm.ate_agora)}</b>${pm.mes_anterior_mesmo_dia ? html`<${Delta} atual=${pm.ate_agora} anterior=${pm.mes_anterior_mesmo_dia} sufixo=" vs mesmo dia do mês passado" />` : null}</div>
        <div><small>No ritmo atual, fecha em</small><b>${brl0(pm.projecao)}</b>${pm.mes_anterior ? html`<${Delta} atual=${pm.projecao} anterior=${pm.mes_anterior} sufixo=" vs mês passado" />` : null}</div>
        <div><small>Mês passado inteiro</small><b>${brl0(pm.mes_anterior)}</b></div>
      </div>
      <div class="db-bl-trilho db-proj-barra" title="quanto do mês já passou x quanto do faturamento do mês passado já foi feito">
        <div class="db-bl-barra" style=${{ width: Math.min(100, pm.mes_anterior ? pm.ate_agora / pm.mes_anterior * 100 : 0) + '%' }}></div>
        <i style=${{ left: (pm.dia / pm.dias_mes * 100) + '%' }}></i></div>
      <div class="vd-muted db-nota">Barra = quanto do faturamento do mês passado já foi feito; o traço marca quanto do mês já passou.</div>
    <//>` : null}
    <${Card} titulo="Destaques do período">
      <div class="db-dest">
        ${d.melhor_dia ? html`<div><small>Melhor dia</small><b>${DSEM[deIso(d.melhor_dia.dia).getDay()]} ${br(d.melhor_dia.dia)}</b><span>${brl(d.melhor_dia.faturamento)} · ${d.melhor_dia.compras} compras</span></div>` : null}
        ${d.pior_dia ? html`<div><small>Dia mais fraco</small><b>${DSEM[deIso(d.pior_dia.dia).getDay()]} ${br(d.pior_dia.dia)}</b><span>${brl(d.pior_dia.faturamento)} · ${d.pior_dia.compras} compras</span></div>` : null}
        <div><small>Produtos diferentes vendidos</small><b>${num(d.skus)}</b><span>${num(k.itens)} unidades</span></div>
        <div><small>Compras com mais de 1 produto</small><b>${pct(d.compras_multiplas_pct)}</b><span>${num(k.itens_por_compra, 1)} itens por compra</span></div>
        <div><small>Margem por dia</small><b>${brl0(k.margem / Math.max(1, d.dias_com_dados))}</b><span>${pct(k.margem_pct)} do faturamento</span></div>
        <div><small>Custo das mercadorias</small><b>${brl0(k.custo)}</b><span>no período</span></div>
      </div>
    <//>
    <${Card} titulo="Faturamento por dia" sub="passe o mouse para ver o dia" cls="db-span2">
      <${GraficoDias} dias=${d.por_dia} anteriores=${d.por_dia_anterior} dica=${dica} />
    <//>
    <${Card} titulo="Acumulado no período" sub="este período x o anterior, dia a dia">
      <${Linhas} dica=${dica} rotulos=${rot} series=${[{ nome: 'Este período', valores: d.acumulado, cor: '#3987e5' }].concat(d.acumulado_anterior ? [{ nome: 'Período anterior', valores: d.acumulado_anterior, cor: '#c3c2b7', tracejado: true }] : [])} />
    <//>
    <${Card} titulo="Média por dia da semana" sub="faturamento médio de cada dia">
      <${Colunas} itens=${semana} valor=${s => s.fat} rotulo=${s => s.n} fmt=${brl0} dica=${dica} destaque=${true}
        conteudo=${s => html`<div><b>${s.n}</b> (${s.oc} no período)</div><div>média ${brl(s.fat)}</div><div>${num(s.compras, 1)} compras por dia</div>`} />
    <//>
    <${Card} titulo="Por hora do dia" sub="compras médias por dia em cada hora" cls="db-span2">
      <${Colunas} itens=${horas} valor=${x => x.compras} rotulo=${x => x.h + 'h'} rotuloCada=${2} fmt=${v => num(v, 1)} dica=${dica} destaque=${true}
        conteudo=${x => html`<div><b>${x.h}h–${x.h + 1}h</b></div><div>${num(x.compras, 1)} compras/dia · ${brl(x.fat)}/dia</div><div>ticket médio ${brl(x.ticket)}</div>`} />
    <//>
    <${Card} titulo="Quando as pessoas compram" sub="dia da semana × hora, soma do período">
      <${MapaCalor} hm=${hm} dica=${dica} />
    <//>
    <${Card} titulo="Categorias" sub="faturamento · margem · variação">
      <${Barras} itens=${d.categorias.slice(0, 10)} valor=${c => c.faturamento} rotulo=${c => titulo(c.nome)}
        extra=${c => html`<span>margem ${pct(c.margem_pct)}</span> <${Delta} atual=${c.faturamento} anterior=${c.anterior} />`} />
    <//>
    <${Card} titulo="Valor das compras" sub="quantas compras em cada faixa de valor">
      <${Colunas} itens=${d.ticket_dist} valor=${x => x.compras} rotulo=${x => x.nome} dica=${dica}
        conteudo=${x => html`<div><b>${x.nome}</b></div><div>${x.compras} compras · ${brl(x.faturamento)}</div>`} />
    <//>
    <${Card} titulo="Itens por compra">
      <${Colunas} itens=${d.itens_dist} valor=${x => x.compras} rotulo=${x => x.nome} dica=${dica} cor="#199e70" />
    <//>
    ${d.por_semana.length > 1 ? html`<${Card} titulo=${d.por_mes.length > 1 ? 'Semanas e meses' : 'Semanas'} cls="db-span2">
      <div class="db-dois">
        <${Tabela} colunas=${[['Semana de', s => br(s.periodo), 0], ['Dias', s => s.dias, 1], ['Faturamento', s => brl(s.faturamento), 1], ['Média/dia', s => brl(s.media_dia), 1], ['Compras', s => s.compras, 1], ['Ticket', s => brl(s.ticket), 1], ['Margem', s => brl(s.margem), 1]]} linhas=${d.por_semana} max=${14} />
        ${d.por_mes.length > 1 ? html`<${Tabela} colunas=${[['Mês', s => mesNome(s.periodo), 0], ['Dias', s => s.dias, 1], ['Faturamento', s => brl(s.faturamento), 1], ['Média/dia', s => brl(s.media_dia), 1], ['Ticket', s => brl(s.ticket), 1]]} linhas=${d.por_mes} />` : null}
      </div>
    <//>` : null}
  </div>`;
}

function AbaProdutos({ d, dica, subParcial }) {
  const k = d.kpi;
  const piorMargem = d.produtos.filter(p => p.margem_pct != null && p.faturamento >= 20).sort((a, b) => a.margem_pct - b.margem_pct).slice(0, 10);
  const maisLucro = [...d.produtos].sort((a, b) => b.margem - a.margem).slice(0, 10);
  const maisQtd = [...d.produtos].sort((a, b) => b.qtd - a.qtd).slice(0, 10);
  return html`<div class="db-grade">
    <${Card} titulo="Curva ABC" sub="quais produtos fazem o faturamento">
      <div class="db-abc-res">${['A', 'B', 'C'].map(c => html`<div key=${c}><span class=${'db-abc ' + c}>${c}</span>
        <b>${d.abc[c].produtos}</b><small>produtos</small><small>${brl0(d.abc[c].faturamento)} (${num(d.abc[c].faturamento / Math.max(1, k.faturamento) * 100)}%)</small></div>`)}</div>
      <div class="vd-muted db-nota">A = os que somam 80% do faturamento (não podem faltar) · B = os próximos 15% · C = o resto.</div>
    <//>
    <${Card} titulo="Fabricantes" sub="faturamento">
      <${Barras} itens=${d.fabricantes.slice(0, 8)} valor=${f => f.faturamento} rotulo=${f => titulo(f.nome)} extra=${f => html`<span>${num(f.qtd)} un</span>`} />
    <//>
    <${Card} titulo="Mapa dos produtos" sub="quanto vende × quanto ganha em cada um" cls="db-span2">
      <${Dispersao} produtos=${d.produtos} dica=${dica} />
    <//>
    <${Card} titulo="Mais vendidos (unidades)">
      <${Barras} itens=${maisQtd} valor=${p => p.qtd} rotulo=${p => p.nome} fmt=${v => num(v) + ' un'} extra=${p => html`<span>${brl(p.faturamento)} · preço médio ${brl(p.preco_medio)}</span>`} />
    <//>
    <${Card} titulo="Os que mais dão lucro" sub="margem em R$ (venda − custo)">
      <${Barras} itens=${maisLucro} valor=${p => p.margem} rotulo=${p => p.nome} cor="#199e70" extra=${p => html`<span>margem ${pct(p.margem_pct)} · ${num(p.qtd)} un</span>`} />
    <//>
    <${Card} titulo="Maiores altas" sub="ganho de faturamento vs período anterior">
      ${d.altas.length ? html`<${Tabela} colunas=${[['Produto', p => p.nome, 0], ['Antes', p => brl(p.anterior), 1], ['Agora', p => brl(p.faturamento), 1], ['Δ', p => html`<span class="db-delta bom">▲ ${brl(p.delta)}</span>`, 1]]} linhas=${d.altas} />` : html`<${Vazio} txt="Sem comparação com o período anterior." />`}
    <//>
    <${Card} titulo="Maiores quedas" sub="inclui os que pararam de vender">
      ${d.quedas.length ? html`<${Tabela} colunas=${[['Produto', p => p.nome, 0], ['Antes', p => brl(p.anterior), 1], ['Agora', p => p.faturamento ? brl(p.faturamento) : html`<span class="db-ruim">parou</span>`, 1], ['Δ', p => html`<span class="db-delta ruim">▼ ${brl(-p.delta)}</span>`, 1]]} linhas=${d.quedas} />` : html`<${Vazio} txt="Sem quedas." />`}
    <//>
    <${Card} titulo="Comprados juntos" sub="pares de produtos que aparecem na mesma compra">
      ${d.cesta.length ? html`<${Tabela} colunas=${[['Produtos', c => html`<div>${c.a}</div><div class="vd-muted">+ ${c.b}</div>`, 0], ['Juntos', c => c.juntos + '×', 1], ['Atração', c => html`<span title="Quantas vezes mais eles saem juntos do que sairiam por acaso">${num(c.lift, 1)}×</span>`, 1]]} linhas=${d.cesta} max=${10} />
        <div class="vd-muted db-nota">"Atração" acima de 1 = saem juntos mais do que o acaso. Bons candidatos a ficar lado a lado ou virar combo.</div>` : html`<${Vazio} txt="Poucas compras com mais de um produto para achar padrões." />`}
    <//>
    <${Card} titulo="Margem mais baixa" sub="produtos que vendem (R$ 20+) com menor margem">
      <${Tabela} colunas=${[['Produto', p => p.nome, 0], ['Preço médio', p => brl(p.preco_medio), 1], ['Margem', p => html`<span class=${p.margem_pct < 15 ? 'db-ruim' : ''}>${pct(p.margem_pct)}</span>`, 1], ['Faturamento', p => brl(p.faturamento), 1]]} linhas=${piorMargem} />
    <//>
    <${Card} titulo="Preços que mudaram" sub="preço médio de venda vs período anterior">
      ${d.precos.length ? html`<${Tabela} colunas=${[['Produto', p => p.nome, 0], ['Antes', p => brl(p.antes), 1], ['Agora', p => brl(p.agora), 1], ['Variação', p => html`<span class=${p.var > 0 ? 'db-delta neutro' : 'db-delta neutro'}>${p.var > 0 ? '▲' : '▼'} ${num(Math.abs(p.var), 1)}%</span>`, 1], ['Vendeu', p => num(p.qtd_antes) + ' → ' + num(p.qtd) + ' un', 1]]} linhas=${d.precos} />` : html`<${Vazio} txt="Nenhum preço mudou mais de 3%." />`}
    <//>
    <${Card} titulo="Novidades e sumidos">
      <div class="db-sub">Venderam agora e não no período anterior</div>
      ${d.novos.length ? html`<ul class="db-lista">${d.novos.slice(0, 8).map(p => html`<li key=${p.codigo}><span>${p.nome}</span><small>${num(p.qtd)} un · ${brl(p.faturamento)}</small></li>`)}</ul>` : html`<${Vazio} txt="Nenhum." />`}
      <div class="db-sep"></div><div class="db-sub">Venderam no período anterior e nada agora (falta na prateleira?)</div>
      ${d.sumiram?.length ? html`<ul class="db-lista">${d.sumiram.slice(0, 8).map(s => html`<li key=${s.codigo}><span>${s.nome}</span><small>${num(s.anterior_qtd)} un · ${brl(s.anterior)}</small></li>`)}</ul>` : html`<${Vazio} txt="Nenhum." />`}
    <//>
    <${Card} titulo="Todos os produtos" sub=${d.produtos.length + ' produtos vendidos · clique no título da coluna para ordenar'} cls="db-span2">
      <${TabelaProdutos} produtos=${d.produtos} />
    <//>
  </div>`;
}

function AbaClientes({ d, dica, subParcial, prog }) {
  const cr = d.clientes_resumo, iv = d.ident_vs_nao || {};
  if (!d.dias_com_detalhes) return html`<div class="db-grade"><${Card} titulo="Clientes" cls="db-span2"><${Vazio} txt=${prog?.pendentes ? 'Baixando as transações do market4u… os dados de clientes aparecem aqui conforme chegam.' : 'Sem dados de transações no período.'} /><//></div>`;
  return html`<div class="db-grade">
    <${Card} titulo="Clientes identificados" sub=${'quem pôs CPF na nota' + subParcial} cls="db-span2">
      <div class="db-cli-res db-cli-6">
        <div><b>${cr.ativos}</b><small>compraram no período</small></div>
        <div><b>${cr.voltaram}</b><small>já tinham comprado no período anterior</small></div>
        <div><b>${cr.novos_no_periodo}</b><small>novos (não compraram no anterior)</small></div>
        <div><b>${cr.nao_voltaram}</b><small>compraram antes e sumiram</small></div>
        <div><b>${pct(d.kpi.pct_identificadas)}</b><small>das compras com CPF</small></div>
        <div><b>${brl(iv.ident?.ticket)}</b><small>ticket de quem põe CPF (sem CPF: ${brl(iv.nao?.ticket)})</small></div>
      </div>
    <//>
    <${Card} titulo="Quem mais compra" sub=${'no período' + subParcial}>
      ${d.clientes.length ? html`<${Tabela} colunas=${[['Cliente', c => c.nome, 0], ['Compras', c => c.compras, 1], ['Gasto', c => brl(c.gasto), 1], ['Ticket', c => brl(c.gasto / Math.max(1, c.compras)), 1], ['Última', c => br(c.ultima), 1], ['Na vida', c => c.compras_total || '—', 1]]} linhas=${d.clientes} max=${12} chave=${c => c.id} />` : html`<${Vazio} txt="Ninguém pôs CPF na nota no período." />`}
    <//>
    <${Card} titulo="Clientes que sumiram" sub="3+ compras e nenhuma há 10 dias ou mais">
      ${d.clientes_risco.length ? html`<${Tabela} colunas=${[['Cliente', c => c.nome, 0], ['Compras', c => c.compras, 1], ['Gasto', c => brl(c.gasto), 1], ['Última', c => br(c.ultima), 1], ['Há', c => html`<span class="db-ruim">${c.dias} dias</span>`, 1]]} linhas=${d.clientes_risco} chave=${c => c.id} />` : html`<${Vazio} txt="Nenhum cliente frequente sumido." />`}
      <div class="vd-muted db-nota">Considera este período e o anterior.</div>
    <//>
    <${Card} titulo="Frequência" sub="quantas vezes cada cliente comprou no período">
      <${Colunas} itens=${d.clientes_frequencia} valor=${x => x.clientes} rotulo=${x => x.nome} dica=${dica} cor="#199e70" />
    <//>
    <${Card} titulo="Última compra" sub="há quanto tempo cada cliente comprou pela última vez">
      <${Colunas} itens=${d.clientes_recencia} valor=${x => x.clientes} rotulo=${x => x.nome} dica=${dica} />
    <//>
    ${d.perfil.faixa.length || d.perfil.sexo.length ? html`<${Card} titulo="Perfil" sub="compras de quem tem cadastro com sexo/idade" cls="db-span2">
      <div class="db-perfil">
        ${d.perfil.sexo.length ? html`<${Barras} itens=${d.perfil.sexo} valor=${s => s.compras} rotulo=${s => s.nome} fmt=${v => num(v)} extra=${s => html`<span>ticket ${brl(s.ticket)}</span>`} />` : null}
        ${d.perfil.faixa.length ? html`<${Barras} itens=${d.perfil.faixa} valor=${s => s.compras} rotulo=${s => s.nome + ' anos'} fmt=${v => num(v)} extra=${s => html`<span>ticket ${brl(s.ticket)}</span>`} />` : null}
      </div>
    <//>` : null}
  </div>`;
}

function AbaOperacao({ d, dica, subParcial, prog }) {
  const f = d.financeiro || {};
  const semDet = !d.dias_com_detalhes;
  return html`<div class="db-grade">
    <${Card} titulo="Formas de pagamento" sub=${'compras concluídas' + subParcial}>
      ${!d.pagamentos.length ? html`<${Vazio} txt=${prog?.pendentes ? 'Baixando…' : 'Sem dados de pagamento no período.'} />` : null}
      <${Barras} itens=${d.pagamentos} valor=${p => p.total} rotulo=${p => p.nome}
        extra=${p => html`<span>${p.compras} compras · ticket ${brl(p.total / Math.max(1, p.compras))}</span>`} />
      ${d.canais.length > 1 ? html`<div class="db-sep"></div><${Barras} itens=${d.canais} valor=${p => p.total} rotulo=${p => p.nome === 'POS' ? 'Maquininha (POS)' : p.nome === 'APP' ? 'App market4u' : p.nome} />` : null}
    <//>
    <${Card} titulo="Tipos de transação" sub=${'tudo o que passou pelo sistema' + subParcial}>
      ${d.tipos_transacao.length ? html`<${Barras} itens=${d.tipos_transacao} valor=${t => t.n} rotulo=${t => t.nome} fmt=${v => num(v)} />` : html`<${Vazio} txt=${semDet ? 'Baixando…' : 'Sem dados.'} />`}
      <div class="db-sep"></div>
      <div class="db-dest db-dest-4">
        <div><small>Descontos</small><b>${brl(f.desconto)}</b><span>${f.n_desconto || 0} compras</span></div>
        <div><small>Estornos</small><b>${brl(f.estorno)}</b><span>${f.n_estorno || 0} compras</span></div>
        <div><small>Vouchers</small><b>${brl(f.voucher)}</b><span>${f.n_voucher || 0} compras</span></div>
        <div><small>Cashback</small><b>${brl(f.cashback)}</b><span>${f.n_cashback || 0} compras</span></div>
      </div>
    <//>
    <${Card} titulo="Desistências por dia" sub=${'compras começadas e removidas' + subParcial} cls="db-span2">
      ${semDet ? html`<${Vazio} txt="Baixando…" />` : html`<${Colunas} itens=${d.desistencias_dia} valor=${x => x.n} rotulo=${x => br(x.dia)} rotuloCada=${Math.ceil(d.desistencias_dia.length / 15)} cor="#d95926" dica=${dica}
        conteudo=${x => html`<div><b>${DSEM[deIso(x.dia).getDay()]} ${br(x.dia)}</b></div><div>${x.n} desistências · ${x.compras} compras</div>`} />`}
    <//>
    <${Card} titulo="Mais tirados do carrinho" sub=${'pegou e devolveu — pode ser preço ou validade' + subParcial}>
      ${d.removidos.length ? html`<${Barras} itens=${d.removidos.slice(0, 10)} valor=${r => r.removidos} rotulo=${r => r.nome} fmt=${v => num(v) + '×'} cor="#d95926"
        extra=${r => html`<span>${num(r.vendidos)} vendidos · tirado em ${r.taxa ?? '—'}% das vezes</span>`} />` : html`<${Vazio} txt=${semDet ? 'Baixando…' : 'Nenhum produto removido no período.'} />`}
    <//>
    <${Card} titulo="Removidos por categoria" sub=${'e por hora do dia' + subParcial}>
      ${d.removidos_categoria.length ? html`<${Barras} itens=${d.removidos_categoria} valor=${r => r.removidos} rotulo=${r => titulo(r.nome)} fmt=${v => num(v) + '×'} cor="#d95926"
        extra=${r => html`<span>${num(r.vendidos)} vendidos</span>`} />
        <div class="db-sep"></div>
        <${Colunas} itens=${d.removidos_hora.map((n, h) => ({ h, n }))} valor=${x => x.n} rotulo=${x => x.h + 'h'} rotuloCada=${3} cor="#d95926" altura=${130} dica=${dica}
          conteudo=${x => html`<b>${x.h}h–${x.h + 1}h</b>: ${x.n} removidos`} />` : html`<${Vazio} txt=${semDet ? 'Baixando…' : 'Nenhum.'} />`}
    <//>
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
  const [aba, setAba] = useState(() => { try { return localStorage.getItem('db_aba') || 'geral'; } catch { return 'geral'; } });
  const escolherAba = a => { setAba(a); try { localStorage.setItem('db_aba', a); } catch {} };
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

          <div class="db-abas">${ABAS.map(([id, r]) => html`<button key=${id} class=${aba === id ? 'on' : ''} onClick=${() => escolherAba(id)}>${r}</button>`)}</div>
          ${aba === 'geral' ? html`<${AbaGeral} d=${dados} dica=${dica} subParcial=${subParcial} prog=${prog} />` : null}
          ${aba === 'produtos' ? html`<${AbaProdutos} d=${dados} dica=${dica} subParcial=${subParcial} prog=${prog} />` : null}
          ${aba === 'clientes' ? html`<${AbaClientes} d=${dados} dica=${dica} subParcial=${subParcial} prog=${prog} />` : null}
          ${aba === 'operacao' ? html`<${AbaOperacao} d=${dados} dica=${dica} subParcial=${subParcial} prog=${prog} />` : null}
        </div>` : null}
    </div>
    ${dicaEl}
  </div>`;
}
