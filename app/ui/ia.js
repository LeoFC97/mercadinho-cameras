// ia.js — aba "Inteligência Artificial": montar a base de fotos para treinar a rede que reconhece os produtos.
// Rotular (caixas + produto), Capturar (câmeras ao vivo em HD / gravações no horário das vendas),
// Produtos (o que a IA vai aprender), Imagens (galeria) e Exportar (pacote YOLO para treinar na RTX).
import { api, lerAutor, salvarAutor, dataHora, hhmmss, brl, isoDia, two } from './comum.js';
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

const META = 150;   // marcações por produto para um treino razoável
const cor = (id) => `hsl(${(id * 67) % 360} 85% 58%)`;
const hojeIso = () => isoDia(Date.now() / 1000);
const addDias = (s, k) => { const [y, m, d] = s.split('-').map(Number); return isoDia(new Date(y, m - 1, d + k).getTime() / 1000); };
const brDia = s => s.split('-').reverse().join('/');

/* ---------------- anotador: desenhar caixas na foto ---------------- */
function Anotador({ img, caixas, setCaixas, classes, classeAtual, sel, setSel }) {
  const area = useRef(null), quadro = useRef(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [novo, setNovo] = useState(null);           // caixa sendo desenhada
  const ini = useRef(null);
  useEffect(() => {
    const calc = () => {
      const a = area.current; if (!a || !img.w) return;
      const W = a.clientWidth, H = a.clientHeight, r = img.w / img.h;
      setFit(W / H > r ? { w: H * r, h: H } : { w: W, h: W / r });
    };
    calc();
    const ro = new ResizeObserver(calc); if (area.current) ro.observe(area.current);
    return () => ro.disconnect();
  }, [img.id, img.w, img.h]);
  const ponto = (e) => {
    const r = quadro.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const down = (e) => {
    if (e.button !== 0 || e.target.closest('.an-box')) return;
    e.preventDefault(); quadro.current.setPointerCapture(e.pointerId);
    ini.current = ponto(e); setNovo({ x: ini.current.x, y: ini.current.y, w: 0, h: 0 }); setSel(-1);
  };
  const move = (e) => {
    if (!ini.current) return;
    const p = ponto(e), a = ini.current;
    setNovo({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) });
  };
  const up = () => {
    if (!ini.current) return;
    ini.current = null;
    if (novo && novo.w > 0.008 && novo.h > 0.008) {
      const lst = [...caixas, { ...novo, classe: classeAtual }];
      setCaixas(lst); setSel(lst.length - 1);
    }
    setNovo(null);
  };
  const nome = (id) => (classes.find(c => c.id === id) || {}).nome || 'escolha o produto →';
  const caixa = (b, i, temp) => html`<div key=${temp ? 'novo' : i} class=${'an-box' + (sel === i ? ' sel' : '') + (b.classe == null ? ' sem' : '')}
      style=${{ left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%',
                borderColor: b.classe == null ? '#fff' : cor(b.classe) }}
      onPointerDown=${temp ? null : (e) => { e.stopPropagation(); setSel(i); }}>
      ${temp ? null : html`<span class="an-tag" style=${{ background: b.classe == null ? '#f0506e' : cor(b.classe) }}>${nome(b.classe)}</span>`}
    </div>`;
  return html`<div class="an-area" ref=${area}>
    <div class="an-quadro" ref=${quadro} style=${{ width: fit.w + 'px', height: fit.h + 'px' }}
         onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
      <img src=${'/api/ia/img/' + img.id + '.jpg'} draggable="false" />
      ${caixas.map((b, i) => caixa(b, i))}
      ${novo ? caixa({ ...novo, classe: classeAtual }, -2, true) : null}
    </div>
  </div>`;
}

/* ---------------- escolha do produto ---------------- */
function Produtos({ classes, atual, onEscolher, onCriado, autor, venda, onToast }) {
  const [busca, setBusca] = useState('');
  const [criando, setCriando] = useState(false);
  const q = busca.trim().toLowerCase();
  const lista = classes.filter(c => !q || (c.nome + ' ' + (c.barras || '')).toLowerCase().includes(q));
  const criar = async (nome, extra = {}) => {
    try { const c = await api('/api/ia/classes', { json: { nome, autor, ...extra } }); onCriado(c); setBusca(''); setCriando(false); }
    catch (e) { onToast('Erro: ' + e.message); }
  };
  return html`<div class="ia-prod">
    ${venda ? html`<div class="ia-venda">
        <div class="md-rot">Vendido neste horário (${hhmmss(venda.t)})</div>
        ${(venda.produtos || []).map(p => { const c = classes.find(x => x.nome.toLowerCase() === p.toLowerCase());
          return html`<button key=${p} class="ia-vp" onClick=${() => c ? onEscolher(c.id) : criar(p)}>
            ${c ? html`<i style=${{ background: cor(c.id) }}></i>` : '+'} ${p}</button>`; })}
      </div>` : null}
    <input class="ia-busca" placeholder="Buscar produto…" value=${busca} onInput=${e => setBusca(e.target.value)}
      onKeyDown=${e => { if (e.key === 'Enter' && lista.length === 1) onEscolher(lista[0].id); }} />
    <div class="ia-plista">
      ${lista.map((c, i) => html`<button key=${c.id} class=${'ia-pitem' + (atual === c.id ? ' on' : '')} onClick=${() => onEscolher(c.id)}>
        <i style=${{ background: cor(c.id) }}></i><span>${c.nome}</span>
        ${i < 9 && !q ? html`<kbd>${i + 1}</kbd>` : null}<small>${c.caixas || 0}</small></button>`)}
      ${!lista.length ? html`<div class="vd-muted" style=${{ padding: '6px' }}>Nenhum produto${q ? ' com esse nome' : ''}.</div>` : null}
    </div>
    ${criando || (q && !lista.some(c => c.nome.toLowerCase() === q))
      ? html`<button class="vd-link" onClick=${() => busca.trim() ? criar(busca.trim()) : setCriando(true)}>+ Criar produto "${busca.trim() || '…'}"</button>`
      : html`<button class="vd-link" onClick=${() => setCriando(true)}>+ Novo produto (digite o nome na busca)</button>`}
  </div>`;
}

/* ---------------- Rotular ---------------- */
function Rotular({ resumo, recarregar, autor, onToast, abrirId, limparAbrir }) {
  const [fila, setFila] = useState(null);
  const [img, setImg] = useState(null);
  const [caixas, setCaixas] = useState([]);
  const [sel, setSel] = useState(-1);
  const [classeAtual, setClasseAtual] = useState(null);
  const [busy, setBusy] = useState(false);
  const classes = resumo?.classes || [];

  const carregarFila = useCallback(async (manter) => {
    try {
      const r = await api('/api/ia/imagens?status=pendente&limite=200&_=' + Date.now());
      setFila(r);
      if (!manter) abrir(r.imagens[0] || null);
    } catch (e) { onToast('Erro: ' + e.message); }
  }, []);
  const abrir = (im) => { setImg(im); setCaixas(im ? (im.caixas || []).map(b => ({ ...b })) : []); setSel(-1); };
  useEffect(() => { carregarFila(!!abrirId); }, []);
  useEffect(() => { if (!abrirId) return;
    api('/api/ia/imagens/' + abrirId).then(abrir).catch(e => onToast('Erro: ' + e.message)); limparAbrir(); }, [abrirId]);

  const escolher = (id) => {
    setClasseAtual(id);
    if (sel >= 0 && caixas[sel]) setCaixas(caixas.map((b, i) => i === sel ? { ...b, classe: id } : b));
  };
  const salvar = async (status) => {
    if (!img) return;
    if (!autor) { onToast('Escreva o seu nome no topo da aba antes de salvar.'); return; }
    if (status !== 'fundo' && caixas.some(b => b.classe == null)) { onToast('Escolha o produto de todas as caixas (as brancas).'); return; }
    if (status !== 'fundo' && !caixas.length) { onToast('Desenhe uma caixa em volta do produto, ou use "Sem produto".'); return; }
    setBusy(true);
    try {
      await api('/api/ia/imagens/' + img.id, { json: { autor, status, caixas: status === 'fundo' ? [] : caixas } });
      const resto = (fila?.imagens || []).filter(x => x.id !== img.id);
      setFila(f => ({ ...f, imagens: resto, total: Math.max(0, (f?.total || 1) - 1) }));
      abrir(resto[0] || null); recarregar();
      if (resto.length < 5) carregarFila(true);
    } catch (e) { onToast('Erro: ' + e.message); }
    setBusy(false);
  };
  const pular = () => { const lst = fila?.imagens || []; const i = lst.findIndex(x => x.id === img?.id); abrir(lst[(i + 1) % lst.length] || null); };
  const apagarFoto = async () => {
    try { await api('/api/ia/imagens/' + img.id + '/apagar', { json: {} });
      const resto = (fila?.imagens || []).filter(x => x.id !== img.id); setFila(f => ({ ...f, imagens: resto, total: (f?.total || 1) - 1 })); abrir(resto[0] || null); recarregar(); }
    catch (e) { onToast('Erro: ' + e.message); }
  };
  // atalhos: 1-9 produto, Del apaga caixa, Enter salva, S sem produto
  // (um único listener que sempre chama a versão mais nova do tratador — trocar o listener a cada
  //  render fazia teclas se perderem quando outra parte da tela atualizava no mesmo instante)
  const teclaRef = useRef(null);
  useEffect(() => { const f = (e) => teclaRef.current && teclaRef.current(e); window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, []);
  {
    const k = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key >= '1' && e.key <= '9' && classes[+e.key - 1]) escolher(classes[+e.key - 1].id);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) { setCaixas(caixas.filter((_, i) => i !== sel)); setSel(-1); }
      else if (e.key === 'Enter') salvar('rotulada');
      else if (e.key.toLowerCase() === 's') salvar('fundo');
    };
    teclaRef.current = k;
  }

  const lst = fila?.imagens || [];
  return html`<div class="ia-rot">
    <div class="ia-fila">
      <div class="md-rot">Fila (${fila?.total ?? '…'})</div>
      ${lst.map(x => html`<button key=${x.id} class=${'ia-th' + (img && x.id === img.id ? ' on' : '')} onClick=${() => abrir(x)}>
        <img src=${'/api/ia/img/' + x.id + '_m.jpg'} loading="lazy" /><span>${hhmmss(x.t)}${x.origem === 'venda' ? ' 🧾' : x.origem === 'ao_vivo' ? ' HD' : ''}</span></button>`)}
      ${fila && !lst.length ? html`<div class="vd-muted" style=${{ padding: '8px' }}>Fila vazia. Tire fotos na aba Capturar.</div>` : null}
    </div>
    <div class="ia-centro">
      ${img ? html`
        <div class="ia-info"><b>${dataHora(img.t)}</b><span class="vd-muted">${img.cam} · ${img.w}×${img.h} · ${img.origem === 'ao_vivo' ? 'ao vivo (HD)' : img.origem === 'venda' ? 'da gravação, no horário de uma venda' : 'da gravação'}${img.autor ? ' · foto de ' + img.autor : ''}</span>
          ${img.status !== 'pendente' ? html`<span class="oc-chip" style=${{ color: '#36d399', borderColor: '#36d399' }}>${img.status === 'fundo' ? 'sem produto' : 'rotulada'}${img.rotulado_por ? ' por ' + img.rotulado_por : ''}</span>` : null}</div>
        <${Anotador} img=${img} caixas=${caixas} setCaixas=${setCaixas} classes=${classes} classeAtual=${classeAtual} sel=${sel} setSel=${setSel} />
        <div class="ia-dica vd-muted">Arraste para desenhar uma caixa bem justa em volta de cada produto. Clique numa caixa para trocar o produto; Delete apaga. Enter salva.</div>
        <div class="ia-acoes">
          <button class="vd-primary" disabled=${busy} onClick=${() => salvar('rotulada')}>✔ Salvar e próxima</button>
          <button class="iconbtn" style=${{ width: 'auto', padding: '0 12px', fontSize: '12.5px' }} disabled=${busy} onClick=${() => salvar('fundo')} title="Nenhum produto à vista (ensina a IA o que não é produto)">Sem produto (S)</button>
          <button class="iconbtn" style=${{ width: 'auto', padding: '0 12px', fontSize: '12.5px' }} onClick=${pular}>Pular</button>
          ${sel >= 0 ? html`<button class="dbtn small" onClick=${() => { setCaixas(caixas.filter((_, i) => i !== sel)); setSel(-1); }}>Apagar caixa</button>` : null}
          <span style=${{ flex: 1 }}></span>
          <button class="dbtn small" onClick=${apagarFoto}>Apagar foto</button>
        </div>`
      : html`<div class="vd-empty"><span>${fila ? 'Nenhuma foto para rotular. Vá em Capturar.' : 'Carregando…'}</span></div>`}
    </div>
    <div class="ia-dir">
      <div class="md-rot">Produto da caixa</div>
      <${Produtos} classes=${classes} atual=${sel >= 0 && caixas[sel] ? caixas[sel].classe : classeAtual} onEscolher=${escolher}
        onCriado=${(c) => { recarregar(); escolher(c.id); }} autor=${autor} venda=${img?.venda} onToast=${onToast} />
      ${caixas.length ? html`<div class="md-rot" style=${{ marginTop: '10px' }}>Caixas nesta foto (${caixas.length})</div>
        ${caixas.map((b, i) => html`<button key=${i} class=${'ia-pitem' + (sel === i ? ' on' : '')} onClick=${() => setSel(i)}>
          <i style=${{ background: b.classe == null ? '#fff' : cor(b.classe) }}></i>
          <span>${(classes.find(c => c.id === b.classe) || {}).nome || '— escolha o produto'}</span></button>`)}` : null}
    </div>
  </div>`;
}

/* ---------------- Capturar ---------------- */
function Capturar({ cameras, nameOf, go2rtc, autor, onToast, onFeito }) {
  const [cams, setCams] = useState(cameras.map(c => c.id));
  const [qtd, setQtd] = useState(5);
  const [intervalo, setIntervalo] = useState(1);
  const [busy, setBusy] = useState(false);
  const [ultimas, setUltimas] = useState([]);
  const [tick, setTick] = useState(0);
  const [dia, setDia] = useState(hojeIso());
  const [vendas, setVendas] = useState(null);
  const [vErr, setVErr] = useState('');
  const [feitas, setFeitas] = useState({});
  const [viaPainel, setViaPainel] = useState({});   // câmeras cuja prévia vem do painel (se o go2rtc não der quadro)
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 4000); return () => clearInterval(id); }, []);
  useEffect(() => { setVendas(null); setVErr('');
    api('/api/analise?dia=' + dia + '&_=' + Date.now()).then(a => { setVendas(a.vendas || []); if (!a.vendas_ok) setVErr(a.vendas_erro || 'vendas indisponíveis — conecte na barra Vendas'); })
      .catch(e => setVErr(e.message)); }, [dia]);
  const tog = id => setCams(cams.includes(id) ? cams.filter(x => x !== id) : [...cams, id]);
  const aoVivo = async () => {
    if (!cams.length) { onToast('Escolha pelo menos uma câmera.'); return; }
    setBusy(true);
    try { const r = await api('/api/ia/capturar', { json: { fonte: 'ao_vivo', cameras: cams, qtd, intervalo, autor } });
      setUltimas(r.imagens); onFeito(); onToast(`${r.imagens.length} foto(s) na fila para rotular` + (r.erros.length ? ' — ' + r.erros.join('; ') : '')); }
    catch (e) { onToast('Erro: ' + e.message); }
    setBusy(false);
  };
  const daVenda = async (v) => {
    if (!cams.length) { onToast('Escolha pelo menos uma câmera.'); return; }
    setFeitas(f => ({ ...f, [v.t]: 'gerando' }));
    try { const r = await api('/api/ia/capturar', { json: { fonte: 'gravacao', cameras: cams, tempos: [v.t - 8, v.t - 4, v.t], autor,
        venda: { t: v.t, total: v.total, produtos: v.produtos } } });
      setFeitas(f => ({ ...f, [v.t]: r.imagens.length })); onFeito(); }
    catch (e) { setFeitas(f => ({ ...f, [v.t]: 'erro' })); onToast('Erro: ' + e.message); }
  };
  return html`<div class="ia-cap">
    <section class="ia-card">
      <h3>📸 Ao vivo, em HD</h3>
      <p class="vd-muted">Segure o produto na frente da câmera (de vários jeitos: na mão, de lado, de costas, longe, perto) e tire uma sequência. Funciona melhor do que as gravações, que são em resolução menor.</p>
      <div class="ia-prev">
        ${cameras.map(c => html`<label key=${c.id} class=${'ia-cam' + (cams.includes(c.id) ? ' on' : '')}>
          <img src=${(viaPainel[c.id] ? '/api/ia/previa/' + encodeURIComponent(c.id) + '.jpg?_=' : go2rtc + '/api/frame.jpeg?src=' + encodeURIComponent(c.id + '_sub') + '&_=') + tick}
            onError=${e => { if (!viaPainel[c.id]) setViaPainel(v => ({ ...v, [c.id]: true })); else e.target.style.opacity = 0; }} onLoad=${e => { e.target.style.opacity = 1; }} />
          <span><input type="checkbox" checked=${cams.includes(c.id)} onChange=${() => tog(c.id)} /> ${nameOf(c)}</span></label>`)}
      </div>
      <div class="ia-linha">
        <label>Fotos por câmera <select value=${qtd} onChange=${e => setQtd(+e.target.value)}>${[1, 3, 5, 10, 20].map(n => html`<option key=${n} value=${n}>${n}</option>`)}</select></label>
        <label>Intervalo <select value=${intervalo} onChange=${e => setIntervalo(+e.target.value)}>${[0.5, 1, 2, 3].map(n => html`<option key=${n} value=${n}>${String(n).replace('.', ',')} s</option>`)}</select></label>
        <button class="vd-primary" disabled=${busy} onClick=${aoVivo}>${busy ? 'Tirando fotos…' : '📸 Tirar fotos agora'}</button>
      </div>
      ${ultimas.length ? html`<div class="ia-ult">${ultimas.map(x => html`<img key=${x.id} src=${'/api/ia/img/' + x.id + '_m.jpg'} />`)}</div>` : null}
    </section>
    <section class="ia-card">
      <h3>🧾 Das gravações, no horário das vendas</h3>
      <p class="vd-muted">Para cada venda, tira 3 fotos de cada câmera (8 e 4 segundos antes, e na hora). Na rotulagem aparece o que foi vendido, para você só marcar onde o produto está.</p>
      <div class="ia-linha">
        <div class="seg">
          <button onClick=${() => setDia(addDias(dia, -1))}>◀</button>
          <button class="on" style=${{ cursor: 'default' }}>${dia === hojeIso() ? 'Hoje' : brDia(dia)}</button>
          <button onClick=${() => setDia(addDias(dia, 1))} disabled=${dia >= hojeIso()}>▶</button>
        </div>
        <span class="vd-muted">${vendas ? vendas.length + ' venda(s)' : ''}</span>
      </div>
      ${vErr ? html`<div class="vd-err">${vErr}</div>` : null}
      <div class="ia-vlista">
        ${(vendas || []).slice().reverse().map(v => html`<div key=${v.t} class="ia-vitem">
          <b>${hhmmss(v.t)}</b><span>${v.produtos.join(', ')}</span><span class="vd-muted">${brl(v.total)}</span>
          ${feitas[v.t] === 'gerando' ? html`<span class="vd-muted">gerando…</span>`
            : typeof feitas[v.t] === 'number' ? html`<span style=${{ color: '#36d399' }}>✔ ${feitas[v.t]} foto(s)</span>`
            : html`<button class="vd-ver" onClick=${() => daVenda(v)}>📸 fotos</button>`}
        </div>`)}
        ${vendas && !vendas.length ? html`<div class="vd-muted">Nenhuma venda nesse dia.</div>` : null}
      </div>
    </section>
  </div>`;
}

/* ---------------- Produtos ---------------- */
function ListaProdutos({ resumo, recarregar, autor, onToast }) {
  const [sug, setSug] = useState(null);
  const [nome, setNome] = useState(''); const [barras, setBarras] = useState('');
  const [edit, setEdit] = useState(null);
  useEffect(() => { api('/api/ia/sugestoes?_=' + Date.now()).then(r => setSug(r.sugestoes)).catch(() => setSug([])); }, [resumo?.classes?.length]);
  const criar = async (d) => { try { await api('/api/ia/classes', { json: { ...d, autor } }); recarregar(); setNome(''); setBarras(''); } catch (e) { onToast('Erro: ' + e.message); } };
  const salvarEd = async () => { try { await api('/api/ia/classes/' + edit.id, { json: { nome: edit.nome, barras: edit.barras } }); setEdit(null); recarregar(); } catch (e) { onToast('Erro: ' + e.message); } };
  const apagar = async (c) => { try { await api('/api/ia/classes/' + c.id + '/apagar', { json: {} }); recarregar(); } catch (e) { onToast('Erro: ' + e.message); } };
  const cls = resumo?.classes || [];
  return html`<div class="ia-prods">
    <section class="ia-card">
      <h3>Produtos que a IA vai aprender (${cls.length})</h3>
      <form class="ia-linha" onSubmit=${e => { e.preventDefault(); if (nome.trim()) criar({ nome: nome.trim(), barras }); }}>
        <input class="ia-busca" style=${{ flex: 2 }} placeholder="Nome do produto (ex.: Coca-Cola lata 350 ml)" value=${nome} onInput=${e => setNome(e.target.value)} />
        <input class="ia-busca" style=${{ flex: 1 }} placeholder="Código de barras (opcional)" value=${barras} onInput=${e => setBarras(e.target.value)} />
        <button class="vd-primary">+ Adicionar</button>
      </form>
      <table class="ia-tab">
        <thead><tr><th>Produto</th><th>Código</th><th>Fotos</th><th style=${{ width: '34%' }}>Marcações (meta ${META})</th><th></th></tr></thead>
        <tbody>${cls.map(c => html`<tr key=${c.id}>
          <td>${edit && edit.id === c.id ? html`<input class="ia-busca" value=${edit.nome} onInput=${e => setEdit({ ...edit, nome: e.target.value })} />`
                : html`<span class="ia-pnome"><i style=${{ background: cor(c.id) }}></i>${c.nome}</span>`}</td>
          <td>${edit && edit.id === c.id ? html`<input class="ia-busca" value=${edit.barras || ''} onInput=${e => setEdit({ ...edit, barras: e.target.value })} />` : html`<span class="vd-muted">${c.barras || '—'}</span>`}</td>
          <td>${c.imagens}</td>
          <td><div class="ia-meta"><div style=${{ width: Math.min(100, c.caixas / META * 100) + '%', background: c.caixas >= META ? '#36d399' : 'var(--accent)' }}></div></div><small>${c.caixas}/${META}</small></td>
          <td class="ia-tdac">${edit && edit.id === c.id
              ? html`<button class="vd-link" onClick=${salvarEd}>Salvar</button> <button class="vd-link" onClick=${() => setEdit(null)}>Cancelar</button>`
              : html`<button class="vd-link" onClick=${() => setEdit({ id: c.id, nome: c.nome, barras: c.barras })}>Editar</button>
                     ${c.caixas ? null : html` <button class="vd-link" style=${{ color: '#ffb3c1' }} onClick=${() => apagar(c)}>Apagar</button>`}`}</td>
        </tr>`)}</tbody>
      </table>
      ${!cls.length ? html`<div class="vd-muted">Nenhum produto ainda. Adicione acima ou pelas sugestões das vendas.</div>` : null}
    </section>
    <section class="ia-card">
      <h3>Sugestões: mais vendidos nas planilhas do market4u</h3>
      ${sug === null ? html`<div class="vd-muted">Carregando…</div>` : !sug.length
        ? html`<div class="vd-muted">Nenhuma sugestão. Elas aparecem depois de buscar vendas na barra Vendas.</div>`
        : html`<div>
            <button class="vd-link" onClick=${async () => { for (const s of sug.slice(0, 10)) await api('/api/ia/classes', { json: { nome: s.nome, barras: s.barras, categoria: s.categoria, autor } }).catch(() => {}); recarregar(); }}>+ Adicionar os 10 mais vendidos</button>
            <div class="ia-sug">${sug.map(s => html`<button key=${s.nome} class="ia-vp" onClick=${() => criar({ nome: s.nome, barras: s.barras, categoria: s.categoria })} title=${s.categoria}>
              + ${s.nome} <small>${Math.round(s.vendas)} vend.</small></button>`)}</div>
          </div>`}
    </section>
  </div>`;
}

/* ---------------- Imagens (galeria) ---------------- */
function Galeria({ resumo, onEditar, onToast }) {
  const [status, setStatus] = useState('rotulada');
  const [classe, setClasse] = useState('');
  const [r, setR] = useState(null);
  useEffect(() => { setR(null);
    api(`/api/ia/imagens?status=${status}&classe=${classe}&limite=400&_=${Date.now()}`).then(setR).catch(e => onToast('Erro: ' + e.message)); }, [status, classe]);
  const cls = resumo?.classes || [];
  const nome = id => (cls.find(c => c.id === id) || {}).nome || '?';
  return html`<div class="ia-gal">
    <div class="ia-linha">
      <div class="seg">${[['rotulada', 'Rotuladas'], ['fundo', 'Sem produto'], ['pendente', 'Na fila'], ['todas', 'Todas']].map(([k, t]) =>
        html`<button key=${k} class=${status === k ? 'on' : ''} onClick=${() => setStatus(k)}>${t}</button>`)}</div>
      <select class="oc-sel" value=${classe} onChange=${e => setClasse(e.target.value)}>
        <option value="">Todos os produtos</option>${cls.map(c => html`<option key=${c.id} value=${c.id}>${c.nome}</option>`)}</select>
      <span class="vd-muted">${r ? r.total + ' foto(s)' : ''}</span>
    </div>
    <div class="ia-grade">
      ${(r?.imagens || []).map(x => html`<button key=${x.id} class="ia-gitem" onClick=${() => onEditar(x.id)} title=${'Abrir para editar — ' + dataHora(x.t)}>
        <div class="ia-gimg"><img src=${'/api/ia/img/' + x.id + '_m.jpg'} loading="lazy" />
          ${(x.caixas || []).map((b, i) => html`<div key=${i} class="ia-gbox" style=${{ left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%', borderColor: cor(b.classe) }}></div>`)}</div>
        <span>${x.status === 'fundo' ? 'sem produto' : (x.caixas || []).map(b => nome(b.classe)).slice(0, 2).join(', ') || 'na fila'}</span>
        <small class="vd-muted">${dataHora(x.t)} · ${x.cam}${x.rotulado_por ? ' · ' + x.rotulado_por : ''}</small>
      </button>`)}
    </div>
    ${r && !r.imagens.length ? html`<div class="vd-empty"><span>Nada aqui ainda.</span></div>` : null}
  </div>`;
}

/* ---------------- Exportar ---------------- */
function Exportar({ resumo, recarregar, onToast }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const gerar = async () => { setBusy(true); try { setRes(await api('/api/ia/exportar', { json: {} })); recarregar(); } catch (e) { onToast('Erro: ' + e.message); } setBusy(false); };
  const ex = resumo?.export;
  const prontos = (resumo?.classes || []).filter(c => c.caixas >= META).length;
  return html`<div class="ia-exp">
    <section class="ia-card">
      <h3>Pacote para treinar a IA</h3>
      <div class="ia-stats">
        <div><small>Fotos rotuladas</small><b>${resumo?.rotuladas ?? '…'}</b></div>
        <div><small>Sem produto</small><b>${resumo?.fundo ?? '…'}</b></div>
        <div><small>Marcações</small><b>${resumo?.caixas ?? '…'}</b></div>
        <div><small>Produtos na meta</small><b>${prontos}/${(resumo?.classes || []).length}</b></div>
      </div>
      <p class="vd-muted">Gera um arquivo .zip no formato YOLO (Ultralytics), com as fotos, as marcações, a lista de produtos e um passo a passo (COMO_TREINAR.txt) para treinar no PC com a RTX. Cerca de 20% das fotos ficam separadas para conferir o resultado.</p>
      <div class="ia-linha">
        <button class="vd-primary" disabled=${busy} onClick=${gerar}>${busy ? 'Gerando…' : '📦 Gerar pacote'}</button>
        ${ex ? html`<a class="vd-link" href="/api/ia/exportar.zip">⬇ Baixar pacote (${(ex.tamanho / 1e6).toFixed(1)} MB, de ${dataHora(ex.em)})</a>` : null}
      </div>
      ${res ? html`<div class="md-info">Pronto: ${res.imagens} fotos (${res.treino} treino, ${res.validacao} validação), ${res.produtos} produto(s).</div>` : null}
      <div class="vd-muted" style=${{ marginTop: '10px' }}>Tudo fica guardado no notebook da loja em <code>${resumo?.pasta || 'dados/ia'}</code> (${resumo?.disco_mb ?? '…'} MB).</div>
    </section>
  </div>`;
}

/* ---------------- aba ---------------- */
export function IAView({ cameras, nameOf, go2rtc, onExit, extraButtons, onToast }) {
  const [aba, setAba] = useState('rotular');
  const [resumo, setResumo] = useState(null);
  const [autor, setAutor] = useState(lerAutor());
  const [abrirId, setAbrirId] = useState(null);
  const recarregar = useCallback(() => api('/api/ia/resumo?_=' + Date.now()).then(setResumo).catch(e => onToast('Erro: ' + e.message)), []);
  useEffect(() => { recarregar(); }, []);
  const abas = [['rotular', `Rotular${resumo ? ' (' + resumo.pendentes + ')' : ''}`], ['capturar', 'Capturar'], ['produtos', `Produtos${resumo ? ' (' + resumo.classes.length + ')' : ''}`], ['imagens', 'Imagens'], ['exportar', 'Exportar']];
  return html`<div style=${{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
    <div class="topbar">
      <button class="iconbtn" title="Voltar ao ao vivo" onClick=${onExit}>✕</button>
      <div class="brand"><h1>Inteligência Artificial</h1><small>${resumo ? `${resumo.rotuladas} fotos rotuladas · ${resumo.caixas} marcações` : ''}</small></div>
      <div class="seg">${abas.map(([k, t]) => html`<button key=${k} class=${aba === k ? 'on' : ''} onClick=${() => setAba(k)}>${t}</button>`)}</div>
      <div class="spacer"></div>
      <label class="ia-autor">👤 <input placeholder="seu nome" value=${autor} onInput=${e => { setAutor(e.target.value); salvarAutor(e.target.value.trim()); }} /></label>
      ${extraButtons || null}
    </div>
    <div class="ia-corpo">
      ${aba === 'rotular' ? html`<${Rotular} resumo=${resumo} recarregar=${recarregar} autor=${autor.trim()} onToast=${onToast} abrirId=${abrirId} limparAbrir=${() => setAbrirId(null)} />` : null}
      ${aba === 'capturar' ? html`<${Capturar} cameras=${cameras} nameOf=${nameOf} go2rtc=${go2rtc} autor=${autor.trim()} onToast=${onToast} onFeito=${recarregar} />` : null}
      ${aba === 'produtos' ? html`<${ListaProdutos} resumo=${resumo} recarregar=${recarregar} autor=${autor.trim()} onToast=${onToast} />` : null}
      ${aba === 'imagens' ? html`<${Galeria} resumo=${resumo} onToast=${onToast} onEditar=${(id) => { setAbrirId(id); setAba('rotular'); }} />` : null}
      ${aba === 'exportar' ? html`<${Exportar} resumo=${resumo} recarregar=${recarregar} onToast=${onToast} />` : null}
    </div>
  </div>`;
}
