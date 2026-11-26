/**
 * ============================================
 * libr4 / convert.js  —  R4 dev
 * ============================================
 * R4.convert: conversor universal de arquivos, sem bibliotecas.
 *   R4.convert(arquivo, 'wav' | 'png' | 'mp4' | 'xlsx' ...) → Promise<{ blob, name, from, to, kind }>
 *   R4.convert.detect(arquivo)       → { kind, format }   (lê os primeiros bytes e a extensão; nunca confia só no nome)
 *   R4.convert.targets(arquivo)      → formatos de saída possíveis agora (considera o que o navegador suporta)
 *   R4.convert.formats()             → tabela { audio, video, image, data } de entrada/saída, pronta p/ montar menus
 *   R4.convert.register(kind, fmts)  → muda a tabela em UM lugar (ex.: restringir os formatos oferecidos aos clientes)
 * Rotas: áudio ⇄ áudio, vídeo → vídeo/áudio/GIF/imagem, imagem ⇄ imagem (+ ICO, GIF, PDF), MIDI → áudio, CSV ⇄ JSON ⇄ XLSX.
 * ============================================
 */
(function (R4) {
  'use strict';
  const D = R4.demux, FILES = () => R4.files;
  const MAX_BYTES = 1024 * 1024 * 1024;
  const fail = (m, code) => { const e = new Error(m); if (code) e.code = code; throw e; };

  const TABLE = {
    audio: { in: ['wav', 'aiff', 'flac', 'mp3', 'ogg', 'opus', 'm4a', 'aac', 'webm', 'mp4', 'midi'], out: ['wav', 'aiff', 'flac', 'opus', 'ogg', 'm4a'] },
    video: { in: ['mp4', 'webm', 'mov'], out: ['mp4', 'webm', 'gif'] },
    image: { in: ['png', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico'], out: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'pdf'] },
    data: { in: ['csv', 'tsv', 'json', 'xlsx'], out: ['csv', 'json', 'xlsx'] }
  };
  const EXT = { jpg: 'jpeg', jpe: 'jpeg', mid: 'midi', oga: 'ogg', mka: 'webm', m4v: 'mp4', qt: 'mov', aif: 'aiff', tif: 'tiff', mpga: 'mp3' };
  const MIME = { wav: 'audio/wav', aiff: 'audio/aiff', flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const norm = f => { f = String(f || '').toLowerCase().replace(/^\./, ''); return EXT[f] || f; };
  const kindOfFormat = (f, dir) => Object.keys(TABLE).filter(k => TABLE[k][dir || 'in'].includes(f));

  const extOf = name => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return m ? norm(m[1]) : ''; };
  const baseOf = name => String(name || 'arquivo').replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\w.\- ()À-ÿ]/g, '_').slice(0, 100) || 'arquivo';

  async function bytesOf(src) {
    if (src instanceof Uint8Array) return src;
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (typeof Blob !== 'undefined' && src instanceof Blob) { if (src.size > MAX_BYTES) fail('Arquivo grande demais (máximo 1 GB).'); return new Uint8Array(await src.arrayBuffer()); }
    return fail('Entrada inválida: use File, Blob ou bytes.');
  }
  const looksText = u => { const n = Math.min(u.length, 2048); for (let i = 0; i < n; i++) { const c = u[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) return false; } return true; };

  /** Descobre o tipo pelo conteúdo (e, para texto, pela extensão). */
  async function detect(src) {
    const name = src && src.name, u = src instanceof Blob ? new Uint8Array(await src.slice(0, 4096).arrayBuffer()) : (await bytesOf(src)).subarray(0, 4096), ex = extOf(name);
    let f = D.sniff(u);
    if (f === 'mp4') { const brand = String.fromCharCode(...u.subarray(8, 12)); f = /^qt/.test(brand) ? 'mov' : (/^M4A|^M4B/.test(brand) || ex === 'm4a') ? 'm4a' : 'mp4'; }
    if (!f && u[0] === 0x50 && u[1] === 0x4b && ex === 'xlsx') f = 'xlsx';
    if (!f && u[0] === 0 && u[1] === 0 && u[2] === 1 && u[3] === 0) f = 'ico';
    if (!f && looksText(u)) { const t = new TextDecoder().decode(u.subarray(0, 512)).trimStart(); f = ex === 'csv' || ex === 'tsv' ? ex : (t[0] === '{' || t[0] === '[') ? 'json' : ex === 'json' ? 'json' : (t.indexOf(',') > -1 || t.indexOf(';') > -1 || t.indexOf('\t') > -1) ? 'csv' : 'text'; }
    f = f === 'jpg' ? 'jpeg' : f;
    if (f === 'ogg' && ex === 'opus') f = 'opus';
    if (f === 'webm' && ex === 'mka') f = 'webm';
    if (!f) f = ex || 'desconhecido';
    f = norm(f);
    let kind = null;
    if (['png', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'tiff'].includes(f)) kind = 'image';
    else if (['wav', 'aiff', 'flac', 'mp3', 'ogg', 'opus', 'm4a', 'aac', 'midi'].includes(f)) kind = 'audio';
    else if (['mp4', 'webm', 'mov'].includes(f)) kind = 'video';
    else if (['csv', 'tsv', 'json', 'xlsx'].includes(f)) kind = 'data';
    return { kind, format: f };
  }

  /** Formatos de saída disponíveis agora para o arquivo. */
  async function targets(src) {
    const d = await detect(src); if (!d.kind) return [];
    let out = TABLE[d.kind].out.slice();
    if (d.kind === 'audio') { const ok = await R4.audio.formats(); out = out.filter(f => ok.includes(f)); }
    if (d.kind === 'image') { const ok = await R4.image.formats(); out = out.filter(f => ok.includes(f)); }
    if (d.kind === 'video') { const ok = await R4.video.formats(); out = out.filter(f => f === 'gif' || ok.includes(f)); out = out.concat(TABLE.audio.out.filter(f => ['wav', 'flac', 'opus', 'm4a', 'ogg', 'aiff'].includes(f))).concat(['jpeg', 'png']); const a = await R4.audio.formats(); out = out.filter(f => !TABLE.audio.out.includes(f) || a.includes(f)); }
    if (d.kind === 'data') out = out.filter(f => f !== d.format);
    return [...new Set(out)].filter(f => f !== d.format);
  }

  async function convert(src, to, opts) {
    opts = opts || {}; to = norm(to); const d = await detect(src), name = baseOf(src && src.name) + '.' + (to === 'jpeg' ? 'jpg' : to);
    const done = (blob, kind) => ({ blob, name, from: d.format, to, kind: kind || d.kind });
    const mime = b => (b.type ? b : new Blob([b], { type: MIME[to] || 'application/octet-stream' }));
    if (!d.kind) fail('Formato do arquivo não reconhecido.', 'format');
    if (d.format === to) return done(src instanceof Blob ? src : new Blob([await bytesOf(src)], { type: MIME[to] }));
    if (d.kind === 'image') {
      if (!TABLE.image.out.includes(to)) fail('Imagem não pode virar ' + to.toUpperCase() + '.', 'format');
      let im = src; if (opts.width || opts.height) im = await R4.image.resize(src, opts);
      return done(await R4.image.encode(im, to, opts));
    }
    if (d.kind === 'audio') {
      if (!TABLE.audio.out.includes(to)) fail('Áudio não pode virar ' + to.toUpperCase() + '.', 'format');
      if (d.format === 'midi') { const m = R4.music.readMIDI(await bytesOf(src)); if (!m.notes.length) fail('MIDI sem notas.'); return done(await R4.audio.encode(R4.music.render(m.notes, { bpm: m.bpm, wave: opts.wave }), to, opts)); }
      let a = await R4.audio.decode(src, opts.sampleRate ? { sampleRate: opts.sampleRate } : undefined);
      if (opts.from != null || opts.to != null) a = R4.audio.trim(a, opts.from || 0, opts.to == null ? a.channels[0].length / a.sampleRate : opts.to);
      if (opts.channels) a = R4.audio.remix(a, opts.channels);
      return done(await R4.audio.encode(a, to, opts));
    }
    if (d.kind === 'video') {
      if (to === 'mp4' || to === 'webm') return done((await R4.video.transcode(src, Object.assign({}, opts, { format: to }))).blob);
      if (to === 'gif') {
        const info = await R4.video.probe(src), n = Math.min(Math.round((opts.fps || 10) * Math.min(info.duration, opts.maxSeconds || 10)), 200), t = Array.from({ length: n }, (_, i) => i / (opts.fps || 10));
        const frames = await R4.video.frame(src, t, { width: opts.width || Math.min(480, info.width), type: 'image/png' });
        return done(await R4.image.gif(frames, { delay: 1000 / (opts.fps || 10) }), 'image');
      }
      if (to === 'jpeg' || to === 'png') return done(await R4.video.frame(src, opts.at || 0, { type: MIME[to], width: opts.width }), 'image');
      if (TABLE.audio.out.includes(to)) return done(await R4.video.extractAudio(src, to, opts), 'audio');
      fail('Vídeo não pode virar ' + to.toUpperCase() + '.', 'format');
    }
    if (d.kind === 'data') {
      const F = FILES(); if (!F) fail('Módulo R4.files não carregado.');
      if (!TABLE.data.out.includes(to)) fail('Dados não podem virar ' + to.toUpperCase() + '.', 'format');
      let rows;
      if (d.format === 'xlsx') rows = (await F.interpretFile(src, opts)).rows;
      else { const text = new TextDecoder().decode(await bytesOf(src)); rows = d.format === 'json' ? [].concat(JSON.parse(text)) : F.parseCSV(text, { delimiter: d.format === 'tsv' ? '\t' : 'auto', header: true, types: true }); if (rows && rows.rows) rows = rows.rows; }
      if (to === 'csv') return done(new Blob([F.toCSV(rows, opts)], { type: 'text/csv;charset=utf-8' }));
      if (to === 'json') return done(new Blob([F.toJSON(rows, opts)], { type: 'application/json' }));
      const x = F.toXLSX(rows, opts); return done(mime(x instanceof Blob ? x : new Blob([x])));
    }
    return fail('Conversão não suportada.', 'format');
  }

  /** Tabela de formatos (cópia). */
  const formats = () => JSON.parse(JSON.stringify(TABLE));
  /** register('audio', { out: ['wav','flac'] }) restringe/estende a tabela de uma categoria. */
  function register(kind, spec) {
    if (!TABLE[kind]) fail('Categoria desconhecida: ' + kind);
    ['in', 'out'].forEach(k => { if (spec && Array.isArray(spec[k])) TABLE[kind][k] = spec[k].map(norm); });
  }

  const api = Object.assign(function (src, to, opts) { return convert(src, to, opts); }, { convert, detect, targets, formats, register, MIME });
  R4.module('convert', api, {
    title: 'R4.convert', group: 'Mídia',
    description: 'Conversor universal sem bibliotecas: reconhece o arquivo pelo conteúdo e converte áudio (WAV, AIFF, FLAC, Opus, OGG, M4A), vídeo (MP4, WebM, GIF, extrair áudio/quadro), imagens (PNG, JPEG, WebP, BMP, ICO, GIF, PDF), MIDI e dados (CSV, JSON, XLSX). A tabela de formatos fica num só lugar e os formatos de saída respeitam o que o navegador consegue codificar.',
    props: [
      { name: 'R4.convert(arquivo, "wav", opções)', type: 'Promise<{blob, name, from, to, kind}>', desc: 'Converte; as opções repassam para o módulo da categoria (bitrate, width, from, to, fps...).' },
      { name: 'detect(arquivo) / targets(arquivo) / formats() / register(categoria, {in, out})', type: '', desc: 'Detectar, listar saídas possíveis, tabela e restringir formatos.' }
    ]
  });
  R4.convert = R4.modules.convert.api;
})(window.R4);
