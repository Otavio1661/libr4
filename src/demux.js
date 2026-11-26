/**
 * ============================================
 * libr4 / demux.js  —  R4 dev
 * ============================================
 * R4.demux: leitores de contêiner escritos à mão (sem bibliotecas): MP4/MOV/M4A, WebM/MKV e Ogg (Opus).
 * R4.demux.parse(bytes) → { format, duration, tracks: [{ kind, codec, width, height, rate, channels, description, packets: [{data,timeUs,durationUs,key}] }] }
 * Entrada NÃO confiável: toda tabela é conferida contra o tamanho do arquivo, com limite de caixas e de amostras.
 * Os pacotes saem prontos para VideoDecoder/AudioDecoder (R4.demux.toChunk) ou para o R4.mux (cópia sem recodificar).
 * ============================================
 */
(function (R4) {
  'use strict';
  const fail = m => { throw new Error(m); };
  const MAX_SAMPLES = 3000000, MAX_BOXES = 200000;
  const ascii = (u, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u[o + i]); return s; };
  const hex = (u, a, b) => Array.from(u.subarray(a, b)).map(x => x.toString(16).padStart(2, '0')).join('');

  /* ================= MP4 ================= */
  function parseMP4(u) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let count = 0;
    const kids = (a, b) => {   // lista de caixas em [a,b)
      const out = []; let p = a;
      while (p + 8 <= b) {
        if (++count > MAX_BOXES) fail('MP4 com caixas demais.');
        let size = dv.getUint32(p), type = ascii(u, p + 4, 4), hl = 8;
        if (size === 1) { if (p + 16 > b) break; size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12); hl = 16; }
        else if (size === 0) size = b - p;
        if (size < hl || p + size > b) { if (type === 'mdat') size = b - p; else break; }
        out.push({ type, start: p + hl, end: p + size }); p += size;
      }
      return out;
    };
    const find = (list, t) => list.find(x => x.type === t);
    const top = kids(0, u.length), moov = find(top, 'moov');
    if (!moov) fail('MP4 sem moov (arquivo incompleto ou fragmentado).');
    const mv = kids(moov.start, moov.end), mvhd = find(mv, 'mvhd');
    const tracks = []; let movieScale = 1000, movieDur = 0;
    if (mvhd) { const v = u[mvhd.start]; movieScale = dv.getUint32(mvhd.start + (v ? 20 : 12)) || 1000; movieDur = v ? dv.getUint32(mvhd.start + 24) * 2 ** 32 + dv.getUint32(mvhd.start + 28) : dv.getUint32(mvhd.start + 16); }
    mv.filter(x => x.type === 'trak').forEach(trak => {
      const tk = kids(trak.start, trak.end), mdia = find(tk, 'mdia'); if (!mdia) return;
      const md = kids(mdia.start, mdia.end), hdlr = find(md, 'hdlr'), mdhd = find(md, 'mdhd'), minf = find(md, 'minf');
      if (!hdlr || !mdhd || !minf) return;
      const handler = ascii(u, hdlr.start + 8, 4), kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
      if (!kind) return;
      const ver = u[mdhd.start], scale = dv.getUint32(mdhd.start + (ver ? 20 : 12)) || 1;
      const stbl = find(kids(minf.start, minf.end), 'stbl'); if (!stbl) return;
      const st = kids(stbl.start, stbl.end), get = t => find(st, t);
      const stsd = get('stsd'), stts = get('stts'), stsz = get('stsz'), stsc = get('stsc'), stco = get('stco') || get('co64'), stss = get('stss'), ctts = get('ctts');
      if (!stsd || !stts || !stsz || !stsc || !stco) return;
      const info = { kind, codec: '', width: 0, height: 0, rate: 0, channels: 0, description: null, packets: [] };
      const se = kids(stsd.start + 8, stsd.end)[0]; if (!se) return;
      const fmt = se.type;
      if (kind === 'video') {
        info.width = dv.getUint16(se.start + 24); info.height = dv.getUint16(se.start + 26);
        const cfg = kids(se.start + 78, se.end), c = cfg.find(x => ['avcC', 'hvcC', 'av1C', 'vpcC'].includes(x.type));
        if (c) info.description = u.slice(c.start, c.end);
        if (fmt === 'avc1' || fmt === 'avc3') info.codec = c ? 'avc1.' + hex(u, c.start + 1, c.start + 4) : 'avc1';
        else if (fmt === 'hvc1' || fmt === 'hev1') info.codec = 'hvc1.1.6.L93.B0';
        else if (fmt === 'av01') info.codec = c ? 'av01.0.' + ((u[c.start + 1] & 31).toString().padStart(2, '0')) + (u[c.start + 1] >> 5 ? 'H' : 'M') + '.08' : 'av01.0.04M.08';
        else if (fmt === 'vp09') info.codec = 'vp09.00.10.08';
        else info.codec = fmt;
      } else {
        info.channels = dv.getUint16(se.start + 16); info.rate = dv.getUint16(se.start + 24);
        const cfg = kids(se.start + 28, se.end);
        if (fmt === 'mp4a') {
          const e = cfg.find(x => x.type === 'esds');
          info.codec = 'mp4a.40.2';
          if (e) {   // procura o DecoderSpecificInfo (tag 0x05) dentro do descritor
            let p = e.start + 4; const end = e.end;
            const rd = () => { let n = 0, i = 0, b; do { b = u[p++]; n = (n << 7) | (b & 127); } while ((b & 128) && ++i < 4); return n; };
            while (p < end) {
              const tag = u[p++]; const len = rd();
              if (tag === 3) p += 3; else if (tag === 4) { const oti = u[p]; if (oti === 0x6B || oti === 0x69) info.codec = 'mp3'; p += 13; }
              else if (tag === 5) { info.description = u.slice(p, p + len); break; } else p += len;
            }
          }
        } else if (fmt === 'Opus') { info.codec = 'opus'; const d = cfg.find(x => x.type === 'dOps'); if (d) { info.description = null; info.rate = 48000; } }
        else if (fmt === 'fLaC') { info.codec = 'flac'; const d = cfg.find(x => x.type === 'dfLa'); if (d) info.description = u.slice(d.start + 4, d.end); }
        else info.codec = fmt;
      }
      // tabelas de amostras
      const n = dv.getUint32(stsz.start + 8), fixed = dv.getUint32(stsz.start + 4);
      if (n > MAX_SAMPLES || (!fixed && stsz.start + 12 + n * 4 > stsz.end)) fail('MP4 com tabela de amostras inválida.');
      const size = i => (fixed || dv.getUint32(stsz.start + 12 + i * 4));
      const nco = dv.getUint32(stco.start + 4), c64 = stco.type === 'co64';
      if (nco > MAX_SAMPLES || stco.start + 8 + nco * (c64 ? 8 : 4) > stco.end) fail('MP4 com tabela de blocos inválida.');
      const chunkOff = i => (c64 ? dv.getUint32(stco.start + 8 + i * 8) * 2 ** 32 + dv.getUint32(stco.start + 12 + i * 8) : dv.getUint32(stco.start + 8 + i * 4));
      const nsc = dv.getUint32(stsc.start + 4); if (stsc.start + 8 + nsc * 12 > stsc.end) fail('MP4 com tabela stsc inválida.');
      const sc = []; for (let i = 0; i < nsc; i++) sc.push([dv.getUint32(stsc.start + 8 + i * 12), dv.getUint32(stsc.start + 12 + i * 12)]);
      const offs = new Array(n); let s = 0;
      for (let ch = 0; ch < nco && s < n; ch++) {
        let per = 0; for (let k = 0; k < sc.length; k++) if (sc[k][0] <= ch + 1) per = sc[k][1];
        let o = chunkOff(ch);
        for (let k = 0; k < per && s < n; k++) { offs[s] = o; o += size(s); s++; }
      }
      const dts = new Array(n); let t = 0, i = 0; const nst = dv.getUint32(stts.start + 4);
      for (let r = 0; r < nst && i < n; r++) { const cnt = dv.getUint32(stts.start + 8 + r * 8), d = dv.getUint32(stts.start + 12 + r * 8); for (let k = 0; k < cnt && i < n; k++) { dts[i++] = [t, d]; t += d; } }
      const cts = new Array(n).fill(0);
      if (ctts) { let q = 0; const nc = dv.getUint32(ctts.start + 4); for (let r = 0; r < nc && q < n; r++) { const cnt = dv.getUint32(ctts.start + 8 + r * 8), d = dv.getInt32(ctts.start + 12 + r * 8); for (let k = 0; k < cnt && q < n; k++) cts[q++] = d; } }
      const keys = stss ? new Set(Array.from({ length: Math.min(dv.getUint32(stss.start + 4), MAX_SAMPLES) }, (_, k) => dv.getUint32(stss.start + 8 + k * 4) - 1)) : null;
      for (let k = 0; k < n; k++) {
        const o = offs[k], sz = size(k);
        if (o == null || !dts[k] || o + sz > u.length) break;
        info.packets.push({ data: u.subarray(o, o + sz), timeUs: Math.round((dts[k][0] + cts[k]) * 1e6 / scale), durationUs: Math.round(dts[k][1] * 1e6 / scale), key: kind === 'audio' || !keys || keys.has(k) });
      }
      tracks.push(info);
    });
    if (!tracks.length) fail('MP4 sem trilhas de áudio/vídeo.');
    return { format: 'mp4', duration: movieDur / movieScale, tracks };
  }

  /* ================= WebM / Matroska ================= */
  function parseWebM(u) {
    let p = 0;
    const vlen = () => { const b = u[p]; if (!b) fail('WebM inválido.'); let n = 1, m = 0x80; while (!(b & m)) { m >>= 1; n++; } let v = b & (m - 1), unk = (b & (m - 1)) === m - 1; for (let i = 1; i < n; i++) { v = v * 256 + u[p + i]; if (u[p + i] !== 255) unk = false; } p += n; return unk ? -1 : v; };
    const vid = () => { const b = u[p]; if (!b) fail('WebM inválido.'); let n = 1, m = 0x80; while (!(b & m)) { m >>= 1; n++; } let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u[p + i]; p += n; return v; };
    const num = (a, b) => { let v = 0; for (let i = a; i < b; i++) v = v * 256 + u[i]; return v; };
    const dvw = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const MASTER = new Set([0x18538067, 0x1654AE6B, 0xAE, 0xE0, 0xE1, 0x1F43B675, 0xA0]);
    const tracks = new Map(); let scale = 1e6, dur = 0, cur = null, clusterTs = 0, count = 0;
    const walk = (end, ctx) => {
      while (p < end && p < u.length) {
        if (++count > 4000000) fail('WebM com elementos demais.');
        const id = vid(); let len = vlen(); const body = p;
        if (len < 0) len = end - body;
        if (body + len > u.length) len = u.length - body;
        if (MASTER.has(id)) {
          if (id === 0xAE) { cur = { kind: '', codec: '', width: 0, height: 0, rate: 0, channels: 0, description: null, packets: [], id: 0 }; walk(body + len, 'track'); tracks.set(cur.id, cur); cur = null; }
          else walk(body + len, id);
          p = body + len; continue;
        }
        if (id === 0x2AD7B1) scale = num(body, body + len);
        else if (id === 0x4489) dur = len === 4 ? dvw.getFloat32(body) : dvw.getFloat64(body);
        else if (id === 0xD7 && cur) cur.id = num(body, body + len);
        else if (id === 0x83 && cur) { const t = num(body, body + len); cur.kind = t === 1 ? 'video' : t === 2 ? 'audio' : ''; }
        else if (id === 0x86 && cur) cur.codec = ascii(u, body, len);
        else if (id === 0x63A2 && cur) cur.description = u.slice(body, body + len);
        else if (id === 0xB0 && cur) cur.width = num(body, body + len);
        else if (id === 0xBA && cur) cur.height = num(body, body + len);
        else if (id === 0xB5 && cur) cur.rate = len === 4 ? dvw.getFloat32(body) : dvw.getFloat64(body);
        else if (id === 0x9F && cur) cur.channels = num(body, body + len);
        else if (id === 0xE7) clusterTs = num(body, body + len);
        else if (id === 0xA3 || id === 0xA1) {   // SimpleBlock / Block
          let q = body; const b = u[q]; let n = 1, m = 0x80; while (!(b & m) && n < 8) { m >>= 1; n++; }
          let tn = b & (m - 1); for (let i = 1; i < n; i++) tn = tn * 256 + u[q + i]; q += n;
          const rel = dvw.getInt16(q); const flags = u[q + 2]; q += 3;
          const t = tracks.get(tn);
          if (t && (flags & 6) === 0) t.packets.push({ data: u.subarray(q, body + len), timeUs: Math.round((clusterTs + rel) * scale / 1000), durationUs: 0, key: id === 0xA3 ? !!(flags & 0x80) : true });
        }
        p = body + len;
      }
    };
    if (u.length < 8 || num(0, 4) !== 0x1A45DFA3) fail('Não é um arquivo WebM/Matroska.');
    walk(u.length, 'root');
    const list = [...tracks.values()].filter(t => t.kind && t.packets.length);
    list.forEach(t => {
      t.packets.sort((a, b) => a.timeUs - b.timeUs);
      t.packets.forEach((k, i) => { k.durationUs = i + 1 < t.packets.length ? t.packets[i + 1].timeUs - k.timeUs : (i ? t.packets[i].timeUs - t.packets[i - 1].timeUs : 0); });
      if (t.packets.length > MAX_SAMPLES) fail('WebM com amostras demais.');
      const c = t.codec;
      t.codec = c === 'V_VP9' ? 'vp09.00.10.08' : c === 'V_VP8' ? 'vp8' : c === 'V_AV1' ? 'av01.0.04M.08' : c === 'V_MPEG4/ISO/AVC' ? (t.description && t.description.length > 4 ? 'avc1.' + hex(t.description, 1, 4) : 'avc1.42001f')
        : c === 'A_OPUS' ? 'opus' : c === 'A_VORBIS' ? 'vorbis' : c === 'A_FLAC' ? 'flac' : c === 'A_AAC' ? 'mp4a.40.2' : c === 'A_MPEG/L3' ? 'mp3' : c;
      if (t.codec === 'opus') { t.description = null; if (!t.rate) t.rate = 48000; }   // o OpusHead não entra na configuração do AudioDecoder para Opus em Ogg-less
      delete t.id;
    });
    if (!list.length) fail('WebM sem trilhas de áudio/vídeo.');
    const last = Math.max(...list.map(t => { const k = t.packets[t.packets.length - 1]; return k.timeUs + k.durationUs; }), 0);
    return { format: 'webm', duration: dur ? dur * scale / 1e9 : last / 1e6, tracks: list };
  }

  /* ================= Ogg (Opus) ================= */
  function parseOgg(u) {
    let p = 0, pend = [], packets = [], pages = 0;
    while (p + 27 <= u.length && ascii(u, p, 4) === 'OggS') {
      if (++pages > 2000000) fail('Ogg com páginas demais.');
      const nseg = u[p + 26]; let q = p + 27 + nseg; if (q > u.length) break;
      let acc = 0;
      for (let i = 0; i < nseg; i++) {
        const l = u[p + 27 + i]; acc += l;
        if (l < 255) { if (q + acc > u.length) break; pend.push(u.subarray(q, q + acc)); const pk = pend.length === 1 ? pend[0] : (() => { let n = 0; pend.forEach(x => { n += x.length; }); const o = new Uint8Array(n); let k = 0; pend.forEach(x => { o.set(x, k); k += x.length; }); return o; })(); pend = []; packets.push(pk); q += acc; acc = 0; }
      }
      if (acc) { if (q + acc <= u.length) pend.push(u.subarray(q, q + acc)); q += acc; }
      p = q;
    }
    if (!packets.length || ascii(packets[0], 0, 8) !== 'OpusHead') fail('Ogg sem Opus (só Ogg/Opus é suportado).');
    const channels = packets[0][9], audio = packets.slice(2); let t = 0;
    const frameMs = cfg => (cfg < 12 ? [10, 20, 40, 60][cfg & 3] : cfg < 16 ? [10, 20][cfg & 1] : [2.5, 5, 10, 20][cfg & 3]);
    const pk = audio.map(d => {
      const code = d[0] & 3, n = code === 0 ? 1 : code === 3 ? (d[1] & 63) : 2, dur = frameMs(d[0] >> 3) * n * 1000;
      const r = { data: d, timeUs: Math.round(t), durationUs: dur, key: true }; t += dur; return r;
    });
    return { format: 'ogg', duration: t / 1e6, tracks: [{ kind: 'audio', codec: 'opus', channels, rate: 48000, description: null, packets: pk }] };
  }

  function parse(input) {
    const u = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : fail('Entrada inválida (use Uint8Array ou ArrayBuffer).');
    if (u.length < 12) fail('Arquivo pequeno demais.');
    if (ascii(u, 4, 4) === 'ftyp' || ascii(u, 4, 4) === 'moov' || ascii(u, 4, 4) === 'mdat') return parseMP4(u);
    if (u[0] === 0x1A && u[1] === 0x45 && u[2] === 0xDF && u[3] === 0xA3) return parseWebM(u);
    if (ascii(u, 0, 4) === 'OggS') return parseOgg(u);
    return fail('Contêiner não reconhecido (esperado MP4, WebM ou Ogg).');
  }
  const toChunk = (pk, kind) => new (kind === 'video' ? EncodedVideoChunk : EncodedAudioChunk)({ type: pk.key ? 'key' : 'delta', timestamp: pk.timeUs, duration: pk.durationUs || undefined, data: pk.data });
  /** Detecta o contêiner pelos primeiros bytes: 'mp4' | 'webm' | 'ogg' | 'wav' | 'aiff' | 'flac' | 'mp3' | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'pdf' | 'midi' | '' */
  function sniff(u) {
    const a = (o, s) => ascii(u, o, s.length) === s;
    if (a(4, 'ftyp')) return 'mp4'; if (u[0] === 0x1A && u[1] === 0x45 && u[2] === 0xDF && u[3] === 0xA3) return 'webm';
    if (a(0, 'OggS')) return 'ogg'; if (a(0, 'RIFF') && a(8, 'WAVE')) return 'wav'; if (a(0, 'RIFF') && a(8, 'WEBP')) return 'webp';
    if (a(0, 'FORM') && a(8, 'AIFF')) return 'aiff'; if (a(0, 'fLaC')) return 'flac'; if (a(0, 'MThd')) return 'midi';
    if (a(0, 'ID3') || (u[0] === 0xFF && (u[1] & 0xE0) === 0xE0)) return 'mp3'; if (a(1, 'PNG')) return 'png';
    if (u[0] === 0xFF && u[1] === 0xD8) return 'jpeg'; if (a(0, 'GIF8')) return 'gif'; if (a(0, 'BM')) return 'bmp'; if (a(0, '%PDF')) return 'pdf';
    return '';
  }

  const api = { parse, parseMP4, parseWebM, parseOgg, toChunk, sniff };
  if (R4 && R4.module) R4.module('demux', api, {
    title: 'R4.demux', group: 'Mídia',
    description: 'Leitores de contêiner feitos à mão: MP4/MOV/M4A, WebM/MKV e Ogg/Opus. Devolvem trilhas, configuração do codec e pacotes com tempo, prontos para o WebCodecs ou para copiar para outro arquivo sem recodificar. Entrada tratada como não confiável.',
    props: [
      { name: 'parse(bytes)', type: '{format, duration, tracks[]}', desc: 'Cada trilha: kind, codec (string do WebCodecs), width/height ou rate/channels, description e packets [{data, timeUs, durationUs, key}].' },
      { name: 'toChunk(pacote, "video"|"audio")', type: 'EncodedVideoChunk | EncodedAudioChunk', desc: 'Para alimentar VideoDecoder/AudioDecoder.' },
      { name: 'sniff(bytes)', type: 'string', desc: 'Reconhece o formato pelos primeiros bytes (mp4, webm, ogg, wav, aiff, flac, mp3, png, jpeg, gif, webp, bmp, pdf, midi).' }
    ]
  });
  if (R4) R4.demux = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window.R4 : undefined);
