// vendas.js — barra lateral "Últimas vendas": busca no market4u (via painel_server) a planilha
// do dia, mostra as vendas agrupadas por transação e leva direto para a Revisão no horário da venda.
const { useState, useEffect, useMemo, useRef } = React;
const html = htm.bind(React.createElement);

const two = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const addDays = (s, k) => { const [y, m, d] = s.split('-').map(Number); return isoDay(new Date(y, m - 1, d + k)); };
const brDay = s => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const brl = v => 'R$ ' + (v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const qtd = q => (Math.abs(q - Math.round(q)) < 1e-6 ? String(Math.round(q)) : String(q).replace('.', ','));
const hora = s => (s || '').slice(11, 19);

async function api(url, opts) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.erro || j.msg || ('HTTP ' + r.status)); e.precisaLogin = !!j.precisa_login; throw e; }
  return j;
}

const IC = {
  x: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  cam: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  dl: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`,
  ref: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.7 4.4A9 9 0 0 0 20.5 15"/></svg>`,
};

// Importação: o market4u não permite mais exportar fora da tela dele, então a planilha vem de
// quem exporta (upload aqui, ou sozinha quando exportada no Chrome da loja -> pasta Downloads).
async function importarArquivos(files) {
  const res = [];
  for (const f of files) {
    const r = await fetch('/api/vendas/importar', { method: 'POST', body: f,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Nome-Arquivo': encodeURIComponent(f.name) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${f.name}: ${j.erro || ('HTTP ' + r.status)}`);
    res.push(j);
  }
  return res;
}
const NOME_TIPO = { vendas: 'Produtos vendidos', transacoes: 'Transações', removidos: 'Produtos removidos' };
const quando = ts => { const d = new Date(ts * 1000); return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`; };

// "N removido(s) ▸": abre a lista do que a pessoa tirou do carrinho nessa transação
function nRemovidos(tx, lista) { return Math.max(lista ? lista.length : 0, parseInt(tx && tx.removidos, 10) || 0); }
function BotaoRemovidos({ id, tx, lista, aberto, onToggle }) {
  const n = nRemovidos(tx, lista);
  if (!n) return null;
  return html`<button class=${'vd-rem-bt' + (aberto ? ' on' : '')} title="Ver quais produtos foram tirados do carrinho" onClick=${() => onToggle(id)}>
    🗑 ${n} removido(s) do carrinho <span class="vd-rem-seta">${aberto ? '▾' : '▸'}</span></button>`;
}
function ListaRemovidos({ lista, onVerCameras }) {
  if (!lista || !lista.length) return html`<div class="vd-rem vd-muted">O market4u ainda não listou quais foram (busque de novo em alguns minutos).</div>`;
  return html`<div class="vd-rem">${lista.map((r, n) => html`<div class="vd-item vd-rem-item" key=${n}>
      <span class="vd-q">${hora(r.datahora).slice(0, 8)}</span>
      <span class="vd-p" title=${r.categoria + (r.codigo ? ' · cód. ' + r.codigo : '')}>${r.produto}</span>
      ${r.t ? html`<button class="vd-ver" title="Ver nas câmeras o momento em que tirou" onClick=${() => onVerCameras(r.t)}>${IC.cam}</button>` : null}
    </div>`)}</div>`;
}

export function VendasPanel({ onClose, onVerCameras, autoBuscar }) {
  const [status, setStatus] = useState(null);
  const [dia, setDia] = useState(isoDay(new Date()));
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [importando, setImportando] = useState(false);
  const [okMsg, setOkMsg] = useState('');
  const arq = useRef(null);
  const [busca, setBusca] = useState('');
  const [soIdent, setSoIdent] = useState(false);
  const [abertos, setAbertos] = useState(() => new Set());   // transações com a lista de removidos aberta
  const alternar = id => setAbertos(a => { const n = new Set(a); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pedido = useRef(0);

  const carregarStatus = async () => {
    try { const s = await api('/api/vendas/status?_=' + Date.now()); setStatus(s); return s; }
    catch (e) { setErr(e.message); return null; }
  };
  const buscar = async (d = dia) => {
    const id = ++pedido.current;
    setBusy(true); setErr('');
    try {
      const r = await api('/api/vendas?dia=' + d + '&_=' + Date.now());
      if (id !== pedido.current) return;
      setData(r);
    } catch (e) {
      if (id !== pedido.current) return;
      setErr(e.message);
    }
    if (id === pedido.current) setBusy(false);
  };

  useEffect(() => { carregarStatus(); buscar(); }, [autoBuscar]);
  const importar = async (files) => {
    if (!files || !files.length) return;
    setImportando(true); setErr(''); setOkMsg('');
    try {
      const rs = await importarArquivos([...files]);
      setOkMsg(rs.map(r => `${NOME_TIPO[r.tipo] || r.tipo}: ${r.linhas} linha(s) em ${r.dias.length} dia(s)`).join(' · '));
      await carregarStatus(); await buscar();
    } catch (e) { setErr(e.message); }
    setImportando(false);
    if (arq.current) arq.current.value = '';
  };

  const mudarDia = (d) => { setDia(d); setData(null); buscar(d); };
  const sair = async () => { await api('/api/vendas/sair', { method: 'POST' }).catch(() => {}); setData(null); carregarStatus(); };

  // agrupa por transação (mantém a ordem: mais recente primeiro)
  const grupos = useMemo(() => {
    if (!data) return [];
    const q = busca.trim().toLowerCase();
    const map = new Map();
    for (const it of data.itens) {
      const k = it.transacao || (it.datahora + '|' + it.produto);
      if (!map.has(k)) map.set(k, { k, t: it.t, datahora: it.datahora, via: it.via, cliente: it.cliente, itens: [], total: 0 });
      const g = map.get(k); g.itens.push(it); g.total += it.valor;
    }
    const tx = data.transacoes || {};
    let out = [...map.values()].map(g => ({ ...g, tx: tx[g.k] || null, email: (g.itens.find(i => i.email) || {}).email || '' }));
    if (soIdent) out = out.filter(g => g.tx && g.tx.identificado);
    if (q) out = out.filter(g => g.itens.some(i => (i.produto + ' ' + i.categoria + ' ' + i.barras).toLowerCase().includes(q))
                             || (g.tx && (g.tx.nome + ' ' + g.tx.cliente_id).toLowerCase().includes(q)));
    return out;
  }, [data, busca, soIdent]);
  // transações sem venda: compra removida, carrinho, cobrança pendente...
  const outras = useMemo(() => {
    if (!data || !data.transacoes) return [];
    const vendidas = new Set(data.itens.map(i => i.transacao));
    return Object.values(data.transacoes).filter(t => !vendidas.has(t.id) && !/^(compra efetuada|pagamento)/i.test(t.tipo))
      .filter(t => !soIdent || t.identificado).sort((a, b) => (b.t || 0) - (a.t || 0));
  }, [data, soIdent]);
  const nIdent = data && data.transacoes ? Object.values(data.transacoes).filter(t => t.identificado && /^compra efetuada/i.test(t.tipo)).length : 0;

  const rem = (data && data.removidos) || {};
  const hoje = isoDay(new Date());
  const r = data?.resumo;
  return html`
    <aside class="vd-panel">
      <div class="vd-head">
        <div class="vd-title"><b>Últimas vendas</b><small>market4u</small></div>
        <button class="iconbtn" title="Fechar" onClick=${onClose}>${IC.x}</button>
      </div>

      ${html`
          <div class="vd-bar">
            <div class="seg">
              <button onClick=${() => mudarDia(addDays(dia, -1))} title="Dia anterior">◀</button>
              <button class="on" style=${{ cursor: 'default' }}>${dia === hoje ? 'Hoje' : brDay(dia)}</button>
              <button onClick=${() => mudarDia(addDays(dia, 1))} disabled=${dia >= hoje} title="Próximo dia">▶</button>
            </div>
            <button class="vd-primary vd-buscar" onClick=${() => arq.current && arq.current.click()} disabled=${importando}>
              ${IC.dl}<span>${importando ? 'Importando…' : 'Importar planilha'}</span></button>
            <input ref=${arq} type="file" accept=".csv,text/csv" multiple style=${{ display: 'none' }} onChange=${e => importar(e.target.files)} />
          </div>
          <div class="vd-imp vd-muted">
            ${status && status.ultima_importacao
              ? html`Última importação: <b>${quando(status.ultima_importacao.quando)}</b> (${NOME_TIPO[status.ultima_importacao.tipo] || ''}${status.ultima_importacao.arquivo ? ' · ' + status.ultima_importacao.arquivo : ''}).`
              : html`Nenhuma planilha importada ainda.`}
            ${' '}Exporte no market4u (Relatórios → Produtos vendidos → exportar CSV). Exportando no Chrome da loja, entra sozinho em até 20 s; de outro lugar, use “Importar planilha”.
          </div>
          ${okMsg ? html`<div class="vd-okmsg">✓ ${okMsg}</div>` : null}

          ${r ? html`<div class="vd-cards">
              <div><small>Total</small><b>${brl(r.total)}</b></div>
              <div><small>Compras</small><b>${r.transacoes}</b></div>
              <div><small>Itens</small><b>${qtd(r.itens)}</b></div>
              <div><small>Última</small><b>${r.ultima ? hora(r.ultima).slice(0, 5) : '—'}</b></div>
            </div>` : null}
          ${data && data.transacoes ? html`<label class="vd-ident"><input type="checkbox" checked=${soIdent} onChange=${e => setSoIdent(e.target.checked)} />
              Só clientes identificados (CPF na nota) — ${nIdent} de ${r ? r.transacoes : 0} compras</label>` : null}
          ${data && data.removidos_erro ? html`<div class="vd-muted" style=${{ padding: '0 14px 8px', fontSize: '11.5px' }}>Lista de produtos removidos indisponível agora: ${data.removidos_erro}</div>` : null}
          ${data && data.transacoes_erro ? html`<div class="vd-muted" style=${{ padding: '0 14px 8px', fontSize: '11.5px' }}>Dados dos clientes indisponíveis agora: ${data.transacoes_erro}</div>` : null}

          ${err ? html`<div class="vd-err" style=${{ margin: '0 14px 10px' }}>${err}</div>` : null}

          ${data ? html`<div class="vd-search"><input placeholder="Filtrar produto, código ou cliente…" value=${busca} onInput=${e => setBusca(e.target.value)} /></div>` : null}

          <div class="vd-list">
            ${!data && busy ? html`<div class="vd-empty"><div class="spin"></div><span>Carregando…</span></div>` : null}
            ${data && !grupos.length ? html`<div class="vd-empty"><span>${busca ? 'Nada encontrado com esse filtro.' : data.sem_planilha ? 'Ainda não há planilha deste dia. Exporte no market4u e importe aqui.' : 'Nenhuma venda nesse dia.'}</span></div>` : null}
            ${grupos.map(g => html`
              <div class="vd-tx" key=${g.k}>
                <div class="vd-txh">
                  <span class="vd-time">${hora(g.datahora)}</span>
                  <span class="vd-via">${g.via || ''}</span>
                  ${g.tx && g.tx.identificado ? html`<span class="vd-cli vd-cli-id" title=${'Cliente ' + g.tx.cliente_id}>👤 ${g.tx.nome}</span>`
                    : html`<span class="vd-cli" title="Sem CPF na nota: a maquininha usa um cliente genérico">${g.tx ? 'sem CPF' : ''}</span>`}
                  <b class="vd-val">${brl(g.total)}</b>
                  ${g.t ? html`<button class="vd-ver" title="Ver nas câmeras (Revisão, 20s antes da venda)" onClick=${() => onVerCameras(g.t)}>${IC.cam}<span>ver</span></button>` : null}
                </div>
                ${g.tx ? html`<div class="vd-cdados">
                    ${g.tx.pagamento ? html`<span>💳 ${g.tx.pagamento.replace(/^POS\s*/i, '')}</span>` : null}
                    ${g.tx.identificado ? html`
                      <span title="Quantas compras esse cliente já fez">🛒 ${g.tx.compras_cliente} compra(s)</span>
                      ${g.tx.status_cliente ? html`<span>${g.tx.status_cliente}</span>` : null}
                      ${g.email ? html`<span title="e-mail do cadastro">✉ ${g.email}</span>` : null}
                      <span class="vd-muted">ID ${g.tx.cliente_id}</span>` : null}
                    <${BotaoRemovidos} id=${g.k} tx=${g.tx} lista=${rem[g.k]} aberto=${abertos.has(g.k)} onToggle=${alternar} />
                  </div>` : (rem[g.k] ? html`<div class="vd-cdados"><${BotaoRemovidos} id=${g.k} lista=${rem[g.k]} aberto=${abertos.has(g.k)} onToggle=${alternar} /></div>` : null)}
                ${abertos.has(g.k) ? html`<${ListaRemovidos} lista=${rem[g.k]} onVerCameras=${onVerCameras} />` : null}
                ${g.itens.map((i, n) => html`<div class="vd-item" key=${n}>
                  <span class="vd-q">${qtd(i.qtd)}×</span>
                  <span class="vd-p" title=${i.categoria + (i.barras ? ' · ' + i.barras : '')}>${i.produto}</span>
                  <span class="vd-iv">${brl(i.valor)}</span>
                </div>`)}
              </div>`)}
            ${outras.length && !busca ? html`<div class="md-rot" style=${{ margin: '12px 0 6px' }}>Outras transações (sem venda concluída)</div>
              ${outras.map(t => html`<div class="vd-tx vd-tx-outra" key=${'o' + t.id}>
                <div class="vd-txh">
                  <span class="vd-time">${hora(t.datahora)}</span>
                  <span class="vd-via">${t.via || ''}</span>
                  <span class="vd-cli">${t.identificado ? '👤 ' + t.nome : 'sem CPF'}</span>
                  <b class="vd-val vd-alerta">${t.tipo}</b>
                  ${t.t ? html`<button class="vd-ver" title="Ver nas câmeras" onClick=${() => onVerCameras(t.t)}>${IC.cam}<span>ver</span></button>` : null}
                </div>
                <div class="vd-cdados">${t.pagamento ? html`<span>💳 ${t.pagamento}</span>` : null}
                  ${t.qtd_produtos ? html`<span>${t.qtd_produtos} produto(s)</span>` : null}
                  ${t.total ? html`<span>${brl(t.total)}</span>` : null}
                  <${BotaoRemovidos} id=${t.id} tx=${t} lista=${rem[t.id]} aberto=${abertos.has(t.id)} onToggle=${alternar} /></div>
                ${abertos.has(t.id) ? html`<${ListaRemovidos} lista=${rem[t.id]} onVerCameras=${onVerCameras} />` : null}
              </div>`)}` : null}
          </div>

          <div class="vd-foot">
            ${data && !data.sem_planilha ? html`<a class="vd-link" href=${'/api/vendas/planilha?dia=' + data.dia} download>${IC.dl} Baixar planilha</a>` : html`<span></span>`}
            <span class="vd-muted">${data && data.buscado_em ? 'atualizado às ' + new Date(data.buscado_em * 1000).toTimeString().slice(0, 5) : ''}</span>
          </div>`}
    </aside>`;
}
