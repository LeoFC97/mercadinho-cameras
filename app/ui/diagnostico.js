// diagnostico.js — "Por que a Revisão está travando?": mede a gravação (q/s de verdade, quadros
// perdidos, resolução), o notebook (CPU) e a rede até a loja (latência e velocidade, pelo navegador).
import { api, Modal } from './comum.js';
const { useState, useEffect } = React;
const html = htm.bind(React.createElement);

async function medirRede(urls) {
  // latência: 5 pings pequenos
  const lat = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); await fetch('/api/ping?_=' + Math.random(), { cache: 'no-store' }); lat.push(performance.now() - t); }
  lat.sort((a, b) => a - b);
  // velocidade: baixa o trecho mais recente de cada câmera, todos ao mesmo tempo (como a Revisão faz)
  const t0 = performance.now();
  const tam = await Promise.all(urls.map(u => fetch(u + '?_=' + Math.random(), { cache: 'no-store' }).then(r => r.arrayBuffer()).then(b => b.byteLength).catch(() => 0)));
  const s = (performance.now() - t0) / 1000;
  const bytes = tam.reduce((a, b) => a + b, 0);
  return { latencia_ms: Math.round(lat[2]), mbps: bytes ? +(bytes * 8 / s / 1e6).toFixed(1) : null, mb: +(bytes / 1e6).toFixed(1), s: +s.toFixed(1) };
}

export function DiagnosticoModal({ cameras, nameOf, qualidade, onClose, onToast }) {
  const [srv, setSrv] = useState(null);
  const [rede, setRede] = useState(null);
  const [err, setErr] = useState('');
  const [trocando, setTrocando] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const d = await api('/api/diagnostico?_=' + Date.now());
        setSrv(d);
        const urls = Object.values(d.cameras).map(c => (c.segmentos || []).find(s => s.url)?.url).filter(Boolean);
        setRede(await medirRede(urls));
      } catch (e) { setErr(e.message); }
    })();
  }, []);
  const q = qualidade ? qualidade() : null;          // quadros descartados pelo navegador (vídeos atuais)
  const cams = srv ? Object.entries(srv.cameras) : [];
  const res = cams.map(([id, c]) => c.resumo).filter(Boolean);
  const kbpsTotal = res.reduce((a, r) => a + r.kbps, 0);
  const precisa = kbpsTotal / 1000;
  const nome = id => { const c = cameras.find(x => x.id === id); return c ? nameOf(c) : id; };

  // conclusões
  const achados = [];
  if (srv) {
    const lento = res.filter(r => r.fps_real < 12);
    if (lento.length) achados.push({ grave: true, txt: `A gravação em si tem poucos quadros por segundo (${lento.map(r => r.fps_real).join(', ')} q/s). Por isso parece "travadinha" mesmo com tudo carregado. ${srv.rec_stream === 'sub' ? 'Aumente o FPS do "stream extra" no app da câmera, ou passe a gravar em HD (veja abaixo) se o stream principal tiver mais q/s.' : 'Aumente o FPS no app da câmera.'}` });
    const buracos = cams.filter(([, c]) => c.resumo && c.resumo.buracos_por_min >= 3);
    if (buracos.length) achados.push({ grave: true, txt: `${buracos.map(([id]) => nome(id)).join(', ')}: a câmera está perdendo quadros no caminho até o notebook (Wi-Fi fraco ou congestionado). O vídeo gravado já sai com pulos — melhore o sinal (repetidor/roteador mais perto) ou reduza a qualidade no app da câmera.` });
    if (srv.cpu != null && srv.cpu >= 85) achados.push({ grave: true, txt: `O notebook está muito ocupado (${Math.round(srv.cpu)}% de CPU). Ele demora para entregar os vídeos.` });
    const nav = (srv.processos || []).filter(p => /^(chrome|msedge|firefox|opera|brave|iexplore)$/i.test(p.nome) && p.cpu >= 15);
    if (nav.length) achados.push({ grave: true, txt: `Tem um navegador aberto no próprio notebook (${nav.map(p => p.nome).join(', ')}) usando ${Math.round(nav.reduce((a, p) => a + p.cpu, 0))}% do processador — provavelmente o painel aberto lá. Feche: o notebook não precisa do painel aberto para gravar.` });
    if (res.some(r => r.keyframe_s > 4)) achados.push({ grave: false, txt: 'Os quadros-chave estão espaçados (mais de 4 s): pular na linha do tempo demora mais para mostrar a imagem.' });
  }
  if (rede && rede.mbps != null) {
    if (rede.mbps < precisa * 1.3) achados.push({ grave: true, txt: `A conexão até a loja está em ${rede.mbps} Mbit/s e ${res.length} câmeras juntas precisam de uns ${precisa.toFixed(1)} Mbit/s. Clique numa câmera na Revisão para ver só ela (fica leve), ou use velocidade 1×.` });
    if (rede.latencia_ms > 250) achados.push({ grave: false, txt: `A latência até a loja está alta (${rede.latencia_ms} ms). No Tailscale, confira se a conexão com o notebook está "direta" e não "relay".` });
  }
  if (q && q.total > 50 && q.perdidos / q.total > 0.1) achados.push({ grave: true, txt: `Este aparelho está descartando ${Math.round(q.perdidos / q.total * 100)}% dos quadros ao tocar (aparelho lento). Veja uma câmera por vez.` });
  const pronto = srv && rede;
  if (pronto && !achados.length) achados.push({ grave: false, txt: 'Não achei problema na gravação, no notebook nem na rede agora. Se travar de novo, rode o diagnóstico no momento em que estiver travando.' });

  const trocar = async (stream) => {
    setTrocando(true);
    try { await api('/api/sistema/gravacao', { json: { stream } }); onToast(stream === 'main' ? 'Passando a gravar em HD (o sistema reinicia em alguns segundos)' : 'Voltando a gravar no modo leve'); setSrv({ ...srv, rec_stream: stream }); }
    catch (e) { onToast('Erro: ' + e.message); }
    setTrocando(false);
  };

  return html`<${Modal} titulo="Diagnóstico da Revisão" onClose=${onClose} largura=${720}>
    ${err ? html`<div class="vd-err">${err}</div>` : null}
    ${!srv ? html`<div class="vd-empty"><div class="spin"></div><span>Analisando as gravações e o notebook…</span></div>` : html`
      <div class="dg-sec">
        <div class="md-rot">Conclusão</div>
        ${achados.map((a, i) => html`<div key=${i} class=${'dg-ach' + (a.grave ? ' grave' : '')}>${a.grave ? '⚠️' : 'ℹ️'} ${a.txt}</div>`)}
        ${!pronto ? html`<div class="vd-muted"><span class="spin" style=${{ display: 'inline-block', width: '12px', height: '12px', verticalAlign: 'middle' }}></span> Medindo a velocidade da conexão…</div>` : null}
      </div>
      <div class="dg-sec">
        <div class="md-rot">Gravação (últimos trechos de cada câmera)</div>
        <table class="ia-tab"><thead><tr><th>Câmera</th><th>Resolução</th><th>Quadros/s</th><th>Quadros perdidos</th><th>Bitrate</th><th>Quadro-chave</th></tr></thead>
        <tbody>${cams.map(([id, c]) => { const r = c.resumo; return html`<tr key=${id}>
          <td>${nome(id)}</td>
          ${r ? html`<td>${r.w}×${r.h} ${r.codec}</td>
            <td class=${r.fps_real < 12 ? 'dg-ruim' : ''}>${r.fps_real}${r.fps_declarado && Math.abs(r.fps_declarado - r.fps_real) > 1 ? html` <small class="vd-muted">(diz ${r.fps_declarado})</small>` : null}</td>
            <td class=${r.buracos_por_min >= 3 ? 'dg-ruim' : ''}>${r.buracos_por_min}/min${r.maior_buraco_s ? html` <small class="vd-muted">(maior ${r.maior_buraco_s}s)</small>` : null}</td>
            <td>${r.kbps} kbit/s</td><td>a cada ${r.keyframe_s}s</td>` : html`<td colspan="5" class="vd-muted">sem gravação recente</td>`}
        </tr>`; })}</tbody></table>
      </div>
      <div class="dg-sec dg-grid">
        <div><small>Notebook (CPU)</small><b>${srv.cpu == null ? '—' : Math.round(srv.cpu) + '%'}</b></div>
        <div><small>Conexão até a loja</small><b>${rede ? (rede.mbps ?? '—') + ' Mbit/s' : '…'}</b></div>
        <div><small>Precisa (todas juntas)</small><b>${precisa.toFixed(1)} Mbit/s</b></div>
        <div><small>Latência</small><b>${rede ? rede.latencia_ms + ' ms' : '…'}</b></div>
        <div><small>Quadros perdidos neste aparelho</small><b>${q && q.total ? Math.round(q.perdidos / q.total * 100) + '%' : '—'}</b></div>
        <div><small>Disco livre</small><b>${srv.disco_livre_gb ?? '—'} GB</b></div>
      </div>
      ${(srv.processos || []).length ? html`<div class="dg-sec">
        <div class="md-rot">O que está usando o processador do notebook agora</div>
        <table class="ia-tab"><thead><tr><th>Programa</th><th>CPU</th><th>Memória</th></tr></thead>
        <tbody>${srv.processos.map(p => html`<tr key=${p.nome}><td>${p.nome}${p.qtd > 1 ? html` <small class="vd-muted">×${p.qtd}</small>` : null}</td>
          <td class=${p.cpu >= 30 ? 'dg-ruim' : ''}>${p.cpu}%</td><td>${p.mem_mb} MB</td></tr>`)}</tbody></table>
      </div>` : null}
      <div class="dg-sec">
        <div class="md-rot">Qualidade da gravação</div>
        <div class="ia-linha">
          <span>Hoje grava: <b>${srv.rec_stream === 'main' ? 'HD (stream principal)' : 'leve (stream extra)'}</b></span>
          ${srv.rec_stream === 'main'
            ? html`<button class="iconbtn" style=${{ width: 'auto', padding: '0 12px', fontSize: '12.5px' }} disabled=${trocando} onClick=${() => trocar('sub')}>Voltar a gravar leve</button>`
            : html`<button class="vd-primary" disabled=${trocando} onClick=${() => trocar('main')}>Gravar em HD</button>`}
        </div>
        <div class="vd-muted" style=${{ fontSize: '12px' }}>HD fica mais nítido (os quadros por segundo dependem do que está configurado em cada stream na câmera), mas ocupa umas 4 a 6 vezes mais disco e precisa de mais internet para ver de fora. O teto de disco continua valendo (apaga as gravações mais antigas primeiro).</div>
      </div>`}
  <//>`;
}
