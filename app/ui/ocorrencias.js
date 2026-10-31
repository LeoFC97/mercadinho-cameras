// ocorrencias.js — aba "Ocorrências": acompanhar o que foi marcado na Revisão
// (status, comentários, histórico, clipe) e os clipes exportados.
import { api, Modal, EstadoClipe, useClipe, lerAutor, salvarAutor, dataHora, hhmmss, brl, STATUS_COR, STATUS_ROT, nomeArquivoClipe } from './comum.js';
const { useState, useEffect, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

const FILTROS = [
  { id: 'abertas', rot: 'Em aberto', f: o => o.status === 'aberta' || o.status === 'analisando' },
  { id: 'confirmada', rot: 'Furto confirmado', f: o => o.status === 'confirmada' },
  { id: 'fechadas', rot: 'Resolvidas/descartadas', f: o => o.status === 'resolvida' || o.status === 'descartada' },
  { id: 'todas', rot: 'Todas', f: () => true },
];

function Chip({ status }) {
  return html`<span class="oc-chip" style=${{ color: STATUS_COR[status], borderColor: STATUS_COR[status] }}>${STATUS_ROT[status] || status}</span>`;
}

function PedirNome({ onOk, onClose }) {
  const [n, setN] = useState(lerAutor());
  return html`<${Modal} titulo="Quem está usando o painel?" onClose=${onClose}>
    <form class="md-form" onSubmit=${e => { e.preventDefault(); if (n.trim()) { salvarAutor(n.trim()); onOk(n.trim()); } }}>
      <label>Seu nome<input value=${n} onInput=${e => setN(e.target.value)} autofocus required /></label>
      <div class="vd-muted">Fica salvo neste navegador e aparece em tudo que você marcar ou comentar.</div>
      <button class="vd-primary">Continuar</button>
    </form>
  <//>`;
}

function Detalhe({ o, cameras, nameOf, onMudou, onVer, onApagado, onToast }) {
  const clipe = useClipe(o.clipe);
  const [coment, setComent] = useState('');
  const [pedeNome, setPedeNome] = useState(null);   // função a rodar depois de saber o nome
  const [editando, setEditando] = useState(false);
  const [titulo, setTitulo] = useState(o.titulo);
  const [descricao, setDescricao] = useState(o.descricao);
  const [armApagar, setArmApagar] = useState(false);
  useEffect(() => { setTitulo(o.titulo); setDescricao(o.descricao); setEditando(false); setArmApagar(false); }, [o.id]);

  const comNome = (fn) => { const a = lerAutor(); if (a) fn(a); else setPedeNome(() => fn); };
  const mudar = (payload) => comNome(async (autor) => {
    try { const r = await api('/api/ocorrencias/' + o.id, { json: { ...payload, autor } }); onMudou(r); }
    catch (e) { onToast('Erro: ' + e.message); }
  });
  const regerar = () => comNome(async (autor) => {
    try {
      const r = await api('/api/ocorrencias/' + o.id + '/clipe', { json: { t0: o.t - 30, t1: o.t + 60, autor,
        cameras: o.cameras.length ? o.cameras : cameras.map(c => c.id), nomes: Object.fromEntries(cameras.map(c => [c.id, nameOf(c)])) } });
      onMudou(r);
    } catch (e) { onToast('Erro: ' + e.message); }
  });
  const apagar = async () => {
    if (!armApagar) { setArmApagar(true); setTimeout(() => setArmApagar(false), 4000); return; }
    try { await api('/api/ocorrencias/' + o.id + '/apagar', { json: { apagar_clipe: true } }); onApagado(o.id); }
    catch (e) { onToast('Erro: ' + e.message); }
  };
  const nomesCams = o.cameras.map(id => { const c = cameras.find(x => x.id === id); return c ? nameOf(c) : id; });
  const eventos = useMemo(() => [
    ...o.historico.map(h => ({ ...h, tipo: 'h' })),
    ...o.comentarios.map(c => ({ ...c, tipo: 'c' })),
  ].sort((a, b) => a.em - b.em), [o]);

  return html`<div class="oc-det">
    ${pedeNome ? html`<${PedirNome} onClose=${() => setPedeNome(null)} onOk=${(n) => { const f = pedeNome; setPedeNome(null); f(n); }} />` : null}
    <div class="oc-det-topo">
      ${editando
        ? html`<input class="oc-tit-in" value=${titulo} onInput=${e => setTitulo(e.target.value)} />`
        : html`<h2>${o.titulo}</h2>`}
      <${Chip} status=${o.status} />
    </div>
    <div class="oc-meta">
      <span>🕒 <b>${dataHora(o.t)}</b></span>
      <span>✍️ marcado por <b>${o.autor}</b> em ${dataHora(o.criado_em)}</span>
      ${nomesCams.length ? html`<span>📷 ${nomesCams.join(', ')}</span>` : null}
    </div>
    ${o.venda ? html`<div class="md-info">Venda mais próxima: <b>${hhmmss(o.venda.t)}</b> — ${brl(o.venda.total)} (${(o.venda.produtos || []).join(', ')})</div>` : null}

    <div class="oc-acoes">
      <button class="vd-primary" onClick=${() => onVer(o.t - 10)}>▶ Ver na Revisão</button>
      <select class="oc-sel" value=${o.status} onChange=${e => mudar({ status: e.target.value })}>
        ${Object.keys(STATUS_ROT).map(k => html`<option key=${k} value=${k}>${STATUS_ROT[k]}</option>`)}
      </select>
      ${editando
        ? html`<button class="vd-link" onClick=${() => { mudar({ titulo, descricao }); setEditando(false); }}>Salvar</button>
               <button class="vd-link" onClick=${() => { setEditando(false); setTitulo(o.titulo); setDescricao(o.descricao); }}>Cancelar</button>`
        : html`<button class="vd-link" onClick=${() => setEditando(true)}>Editar</button>`}
      <span class="spacer" style=${{ flex: 1 }}></span>
      <button class=${'dbtn small' + (armApagar ? ' armed' : '')} onClick=${apagar}>${armApagar ? 'Confirmar?' : 'Apagar'}</button>
    </div>

    ${editando
      ? html`<textarea class="oc-desc-in" rows="4" value=${descricao} onInput=${e => setDescricao(e.target.value)}></textarea>`
      : o.descricao ? html`<p class="oc-desc">${o.descricao}</p>` : null}

    <div class="oc-bloco">
      <div class="md-rot">Clipe</div>
      ${o.clipe ? html`<${EstadoClipe} clipe=${clipe} />` : html`<div class="vd-muted">Sem clipe.</div>`}
      ${!o.clipe || (clipe && clipe.status === 'erro')
        ? html`<button class="vd-link" onClick=${regerar}>🎬 Gerar clipe (30s antes, 60s depois)</button>` : null}
    </div>

    <div class="oc-bloco">
      <div class="md-rot">Acompanhamento</div>
      <div class="oc-timeline">
        ${eventos.map((ev, i) => html`<div key=${i} class=${'oc-ev ' + ev.tipo}>
          <div class="oc-ev-cab"><b>${ev.autor}</b> <span class="vd-muted">${ev.tipo === 'h' ? ev.acao : 'comentou'} · ${dataHora(ev.em)}</span></div>
          ${ev.tipo === 'c' ? html`<div class="oc-ev-txt">${ev.texto}</div>` : null}
        </div>`)}
      </div>
      <form class="oc-coment" onSubmit=${e => { e.preventDefault(); if (!coment.trim()) return; mudar({ comentario: coment.trim() }); setComent(''); }}>
        <textarea rows="2" placeholder=${'Escreva um comentário' + (lerAutor() ? ' como ' + lerAutor() : '') + '…'} value=${coment} onInput=${e => setComent(e.target.value)}></textarea>
        <button class="vd-primary" disabled=${!coment.trim()}>Comentar</button>
      </form>
    </div>
  </div>`;
}

export function OcorrenciasView({ cameras, nameOf, onExit, onVer, abrirId, extraButtons, onToast }) {
  const [dados, setDados] = useState(null);
  const [err, setErr] = useState('');
  const [filtro, setFiltro] = useState('abertas');
  const [aba, setAba] = useState('ocorrencias');      // 'ocorrencias' | 'clipes'
  const [sel, setSel] = useState(abrirId || null);
  const [autor, setAutor] = useState(lerAutor());
  const [trocarNome, setTrocarNome] = useState(false);

  const carregar = useCallback(async () => {
    try { setDados(await api('/api/ocorrencias?_=' + Date.now())); setErr(''); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { carregar(); const id = setInterval(carregar, 10000); return () => clearInterval(id); }, []);
  useEffect(() => { if (abrirId) { setSel(abrirId); setFiltro('todas'); setAba('ocorrencias'); } }, [abrirId]);

  const lista = useMemo(() => {
    const f = FILTROS.find(x => x.id === filtro).f;
    return (dados?.ocorrencias || []).filter(f);
  }, [dados, filtro]);
  const atual = (dados?.ocorrencias || []).find(o => o.id === sel) || null;
  const atualizarUm = (o) => setDados(d => ({ ...d, ocorrencias: d.ocorrencias.map(x => x.id === o.id ? o : x) }));
  const contagem = id => (dados?.ocorrencias || []).filter(FILTROS.find(x => x.id === id).f).length;
  const clipesSoltos = (dados?.clipes || []);

  return html`<div style=${{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
    <div class="topbar">
      <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>✕</button>
      <div class="brand"><h1>Ocorrências</h1><small>${(dados?.ocorrencias || []).length} no total</small></div>
      <div class="seg">
        <button class=${aba === 'ocorrencias' ? 'on' : ''} onClick=${() => setAba('ocorrencias')}>Ocorrências</button>
        <button class=${aba === 'clipes' ? 'on' : ''} onClick=${() => setAba('clipes')}>Clipes (${clipesSoltos.length})</button>
      </div>
      <div class="spacer"></div>
      <button class="vd-link" onClick=${() => setTrocarNome(true)} title="Trocar o nome usado nas marcações">👤 ${autor || 'definir meu nome'}</button>
      ${extraButtons || null}
    </div>
    ${trocarNome ? html`<${PedirNome} onClose=${() => setTrocarNome(false)} onOk=${(n) => { setAutor(n); setTrocarNome(false); }} />` : null}
    ${err ? html`<div class="vd-err" style=${{ margin: '12px' }}>${err}</div>` : null}

    ${aba === 'clipes'
      ? html`<div class="oc-clipes">
          ${clipesSoltos.length ? clipesSoltos.map(c => html`<${CartaoClipe} key=${c.id} c=${c} cameras=${cameras} nameOf=${nameOf}
              onVer=${onVer} onApagado=${carregar} onToast=${onToast}
              ocorrencia=${(dados.ocorrencias || []).find(o => o.id === c.ocorrencia)}
              onAbrirOc=${(id) => { setSel(id); setFiltro('todas'); setAba('ocorrencias'); }} />`)
            : html`<div class="vd-empty"><span>Nenhum clipe ainda. Gere pela Revisão (🎬 Exportar clipe) ou ao marcar uma ocorrência.</span></div>`}
        </div>`
      : html`<div class="oc-wrap">
          <div class="oc-lista">
            <div class="oc-filtros">
              ${FILTROS.map(f => html`<button key=${f.id} class=${'oc-filtro' + (filtro === f.id ? ' on' : '')} onClick=${() => setFiltro(f.id)}>
                ${f.rot} <span>${contagem(f.id)}</span></button>`)}
            </div>
            ${!dados ? html`<div class="vd-empty"><div class="spin"></div></div>` : null}
            ${dados && !lista.length ? html`<div class="vd-empty"><span>Nada aqui. Marque ocorrências na Revisão com 🚩.</span></div>` : null}
            ${lista.map(o => html`<button key=${o.id} class=${'oc-item' + (o.id === sel ? ' on' : '')} onClick=${() => setSel(o.id)}>
              <div class="oc-item-l1"><b>${o.titulo}</b><${Chip} status=${o.status} /></div>
              <div class="oc-item-l2 vd-muted">${dataHora(o.t)} · ${o.autor}${o.comentarios.length ? ` · 💬 ${o.comentarios.length}` : ''}${o.clipe ? ' · 🎬' : ''}</div>
            </button>`)}
          </div>
          <div class="oc-painel">
            ${atual ? html`<${Detalhe} o=${atual} cameras=${cameras} nameOf=${nameOf} onVer=${onVer} onToast=${onToast}
                onMudou=${atualizarUm} onApagado=${() => { setSel(null); carregar(); }} />`
              : html`<div class="vd-empty"><span>Escolha uma ocorrência na lista.</span></div>`}
          </div>
        </div>`}
  </div>`;
}

function CartaoClipe({ c, cameras, nameOf, ocorrencia, onVer, onApagado, onAbrirOc, onToast }) {
  const vivo = useClipe(c.status === 'pronto' || c.status === 'erro' ? null : c.id);
  const m = vivo || c;
  const [arm, setArm] = useState(false);
  const apagar = async () => {
    if (!arm) { setArm(true); setTimeout(() => setArm(false), 4000); return; }
    try { await api('/api/clipes/' + c.id + '/apagar', { json: {} }); onApagado(); } catch (e) { onToast('Erro: ' + e.message); }
  };
  return html`<div class="oc-cartao">
    ${m.status === 'pronto' ? html`<video src=${m.arquivo} controls playsinline preload="metadata" class="cl-video"></video>` : html`<${EstadoClipe} clipe=${m} />`}
    <div class="oc-cartao-info">
      <b>${dataHora(m.t0)} → ${hhmmss(m.t1)}</b>
      <span class="vd-muted">${Math.round(m.t1 - m.t0)}s · ${m.cams.length} câm.${m.autor ? ' · ' + m.autor : ''}</span>
      ${ocorrencia ? html`<button class="vd-link" onClick=${() => onAbrirOc(ocorrencia.id)}>⚑ ${ocorrencia.titulo}</button>` : null}
      <div class="oc-acoes">
        ${m.status === 'pronto' ? html`<a class="vd-link" href=${m.arquivo} download=${nomeArquivoClipe(m)}>⬇ Baixar</a>` : null}
        <button class="vd-link" onClick=${() => onVer(m.t0)}>▶ Revisão</button>
        <span class="spacer" style=${{ flex: 1 }}></span>
        <button class=${'dbtn small' + (arm ? ' armed' : '')} onClick=${apagar}>${arm ? 'Confirmar?' : 'Apagar'}</button>
      </div>
    </div>
  </div>`;
}
