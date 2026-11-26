/**
 * ============================================
 * libr4 / mux.js  —  R4 dev
 * ============================================
 * R4.mux: empacotadores de contêiner escritos à mão (sem bibliotecas): WebM (Matroska), MP4 (ISO BMFF) e Ogg.
 * Recebem os pacotes já codificados (WebCodecs: EncodedVideoChunk / EncodedAudioChunk, ou { data, timeUs, durationUs, key })
 * e devolvem os bytes do arquivo. Tudo em memória, com limite de tamanho.
 *
 *   const m = R4.mux.webm({ video: { codec: 'vp09.00.10.08', width, height, description }, audio: { codec: 'opus', rate: 48000, channels: 2, description } });
 *   m.add('video', chunk); m.add('audio', chunk);  const bytes = m.finish();
 *
 * Pacote: { data: Uint8Array, timeUs, durationUs, key }. Para chunks do WebCodecs use R4.mux.fromChunk(chunk).
 * ============================================
 */
(function (R4) {
  'use strict';
  const fail = m => { throw new Error(m); };
  const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
  const cat = parts => { let n = 0; parts.forEach(p => { n += p.length; }); const o = new Uint8Array(n); let k = 0; parts.forEach(p => { o.set(p, k); k += p.length; }); return o; };
  const u8 = (...a) => Uint8Array.from(a);
  const be = (v, n) => { const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = v % 256; v = Math.floor(v / 256); } return o; };
  const str = s => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o; };
  const utf8 = s => new TextEncoder().encode(s);

  /** Converte um EncodedVideoChunk/EncodedAudioChunk em pacote do mux. */
  function fromChunk(c) {
    const d = new Uint8Array(c.byteLength); c.copyTo(d);
    return { data: d, timeUs: c.timestamp, durationUs: c.duration || 0, key: c.type === 'key' };
  }
  const track = (list, kind, p) => { const t = { kind, cfg: p, packets: [], bytes: 0 }; list.push(t); return t; };
  function addPacket(self, kind, pk) {
    const t = self.tracks.find(x => x.kind === kind);
    if (!t) fail('Trilha "' + kind + '" não configurada.');
    if (typeof pk.byteLength === 'number' && typeof pk.copyTo === 'function') pk = fromChunk(pk);
    if (!(pk.data instanceof Uint8Array)) fail('Pacote inválido.');
    self.total += pk.data.length;
    if (self.total > MAX_BYTES) fail('Arquivo grande demais para empacotar em memória.');
    t.packets.push({ data: pk.data, timeUs: Math.max(0, Math.round(pk.timeUs || 0)), durationUs: Math.max(0, Math.round(pk.durationUs || 0)), key: pk.key !== false });
  }
  const durOf = t => { let m = 0; t.packets.forEach(p => { m = Math.max(m, p.timeUs + p.durationUs); }); return m; };

  /* ================= WebM / Matroska ================= */
  const vint = n => {   // tamanho de elemento EBML
    if (n < 0x7f) return u8(0x80 | n);
    if (n < 0x3fff) return u8(0x40 | (n >> 8), n & 255);
    if (n < 0x1fffff) return u8(0x20 | (n >> 16), (n >> 8) & 255, n & 255);
    if (n < 0x0fffffff) return u8(0x10 | (n >> 24), (n >> 16) & 255, (n >> 8) & 255, n & 255);
    return cat([u8(0x01), be(n, 7)]);
  };
  const idb = id => { const a = []; while (id > 0) { a.unshift(id & 255); id = Math.floor(id / 256); } return Uint8Array.from(a); };
  const el = (id, ...payload) => { const p = cat(payload.filter(Boolean)); return cat([idb(id), vint(p.length), p]); };
  const uint = (id, v) => { let n = 1; while (v >= 2 ** (8 * n)) n++; return el(id, be(v, n)); };
  const flt = (id, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); };
  const txt = (id, s) => el(id, utf8(s));
  const CODEC_MKV = c => {
    c = String(c).toLowerCase();
    if (c.startsWith('vp09') || c === 'vp9') return 'V_VP9';
    if (c === 'vp8') return 'V_VP8';
    if (c.startsWith('av01')) return 'V_AV1';
    if (c.startsWith('avc1') || c.startsWith('avc3')) return 'V_MPEG4/ISO/AVC';
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'V_MPEGH/ISO/HEVC';
    if (c === 'opus') return 'A_OPUS';
    if (c === 'vorbis') return 'A_VORBIS';
    if (c === 'flac') return 'A_FLAC';
    if (c.startsWith('mp4a')) return 'A_AAC';
    if (c === 'mp3') return 'A_MPEG/L3';
    return fail('Codec não suportado no WebM: ' + c);
  };

  /** Opus: cabeçalho OpusHead (para WebM/Ogg). */
  function opusHead(channels, rate, preskip) {
    const h = new Uint8Array(19), dv = new DataView(h.buffer);
    h.set(str('OpusHead')); h[8] = 1; h[9] = channels; dv.setUint16(10, preskip == null ? 312 : preskip, true); dv.setUint32(12, rate, true); dv.setInt16(16, 0, true); h[18] = 0;
    return h;
  }

  function webm(o) {
    o = o || {};
    const self = { tracks: [], total: 0 };
    if (o.video) track(self.tracks, 'video', o.video);
    if (o.audio) track(self.tracks, 'audio', o.audio);
    if (!self.tracks.length) fail('Informe vídeo e/ou áudio.');
    self.add = (kind, pk) => addPacket(self, kind, pk);
    self.finish = () => {
      const ids = new Map(); self.tracks.forEach((t, i) => ids.set(t, i + 1));
      const dur = Math.max(...self.tracks.map(durOf), 0) / 1000;
      const header = el(0x1A45DFA3, uint(0x4286, 1), uint(0x42F7, 1), uint(0x42F2, 4), uint(0x42F3, 8), txt(0x4282, o.doctype === 'matroska' ? 'matroska' : 'webm'), uint(0x4287, 4), uint(0x4285, 2));
      const info = el(0x1549A966, uint(0x2AD7B1, 1000000), flt(0x4489, dur), txt(0x4D80, 'R4 dev (libr4)'), txt(0x5741, 'R4 dev (libr4)'));
      const entries = self.tracks.map(t => {
        const c = t.cfg, id = ids.get(t), codec = CODEC_MKV(c.codec);
        const common = [uint(0xD7, id), uint(0x73C5, id), uint(0x83, t.kind === 'video' ? 1 : 2), uint(0x9C, 0), txt(0x86, codec)];
        if (c.description && c.description.byteLength) common.push(el(0x63A2, new Uint8Array(c.description.buffer ? c.description.buffer.slice(c.description.byteOffset, c.description.byteOffset + c.description.byteLength) : c.description)));
        else if (codec === 'A_OPUS') common.push(el(0x63A2, opusHead(c.channels || 2, c.rate || 48000)), uint(0x56AA, 6500000), uint(0x56BB, 80000000));
        if (t.kind === 'video') common.push(el(0xE0, uint(0xB0, c.width), uint(0xBA, c.height)));
        else common.push(el(0xE1, flt(0xB5, c.rate || 48000), uint(0x9F, c.channels || 2)));
        return el(0xAE, ...common);
      });
      const tracks = el(0x1654AE6B, ...entries);
      // pacotes intercalados por tempo; clusters de até ~5 s (e que cabem no int16 relativo)
      const all = []; self.tracks.forEach(t => t.packets.forEach(p => all.push({ t, p })));
      all.sort((a, b) => a.p.timeUs - b.p.timeUs || (a.t.kind === 'video' ? -1 : 1));
      const clusters = [], cues = []; let cur = null, base = 0;
      all.forEach(({ t, p }) => {
        const ms = Math.round(p.timeUs / 1000);
        if (!cur || (ms - base) > 5000 || (t.kind === 'video' && p.key && ms - base > 1000)) {
          cur = { ms, blocks: [] }; base = ms; clusters.push(cur);
          if (t.kind === 'video' && p.key) cur.cue = { ms, track: ids.get(t) };
        }
        const rel = ms - base, hdr = cat([vint(ids.get(t)), be(rel & 0xffff, 2), u8(p.key ? 0x80 : 0)]);
        cur.blocks.push(el(0xA3, hdr, p.data));
      });
      const clusterBytes = clusters.map(c => el(0x1F43B675, uint(0xE7, c.ms), ...c.blocks));
      // Cues: posições relativas ao início dos dados do Segment
      const headBytes = cat([info, tracks]);
      const seekHeadSize = 0; let off = headBytes.length + seekHeadSize;
      const cueTmp = [];
      clusters.forEach((c, i) => { if (c.cue) cueTmp.push({ ms: c.ms, track: c.cue.track, pos: off }); off += clusterBytes[i].length; });
      const cuesBytes = cueTmp.length ? el(0x1C53BB6B, ...cueTmp.map(q => el(0xBB, uint(0xB3, q.ms), el(0xB7, uint(0xF7, q.track), uint(0xF1, q.pos))))) : null;
      const segment = cat([idb(0x18538067), vint(headBytes.length + clusterBytes.reduce((s, c) => s + c.length, 0) + (cuesBytes ? cuesBytes.length : 0)), headBytes, ...clusterBytes, cuesBytes || new Uint8Array(0)]);
      return cat([header, segment]);
    };
    return self;
  }

  /* ================= MP4 (ISO BMFF) ================= */
  const box = (type, ...p) => { const b = cat(p.filter(Boolean)); return cat([be(8 + b.length, 4), str(type), b]); };
  const full = (type, ver, flags, ...p) => box(type, u8(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...p);
  const MATRIX = cat([be(0x00010000, 4), be(0, 4), be(0, 4), be(0, 4), be(0x00010000, 4), be(0, 4), be(0, 4), be(0, 4), be(0x40000000, 4)]);

  function esds(c) {   // descritor ES para AAC (ou mp3)
    const dsi = c.description ? new Uint8Array(c.description.buffer ? c.description.buffer.slice(c.description.byteOffset, c.description.byteOffset + c.description.byteLength) : c.description) : new Uint8Array(0);
    const len = n => u8(n);
    const dec = cat([u8(0x04), len(13 + 2 + dsi.length), u8(0x40, 0x15), be(0, 3), be(0, 4), be(0, 4), u8(0x05), len(dsi.length), dsi]);
    const sl = u8(0x06, 0x01, 0x02);
    return full('esds', 0, 0, u8(0x03), len(3 + dec.length + sl.length), be(1, 2), u8(0), dec, sl);
  }
  function sampleEntry(t) {
    const c = t.cfg, co = String(c.codec).toLowerCase();
    const desc = c.description ? new Uint8Array(c.description.buffer ? c.description.buffer.slice(c.description.byteOffset, c.description.byteOffset + c.description.byteLength) : c.description) : null;
    if (t.kind === 'video') {
      const base = cat([new Uint8Array(6), be(1, 2), new Uint8Array(16), be(c.width, 2), be(c.height, 2), be(0x00480000, 4), be(0x00480000, 4), be(0, 4), be(1, 2), new Uint8Array(32), be(0x0018, 2), be(0xffff, 2)]);
      const kind = co.startsWith('avc') ? ['avc1', 'avcC'] : co.startsWith('hev') || co.startsWith('hvc') ? ['hvc1', 'hvcC'] : co.startsWith('av01') ? ['av01', 'av1C'] : co.startsWith('vp09') ? ['vp09', 'vpcC'] : null;
      if (!kind) fail('Codec de vídeo não suportado no MP4: ' + co);
      if (kind[1] !== 'vpcC' && !desc) fail('O codec precisa da configuração (description) para MP4.');
      return box(kind[0], base, kind[1] === 'vpcC' ? full('vpcC', 1, 0, u8(0, 0x14, 0x80, 2, 2, 2), be(0, 2)) : box(kind[1], desc));
    }
    const base = cat([new Uint8Array(6), be(1, 2), new Uint8Array(8), be(c.channels || 2, 2), be(16, 2), be(0, 2), be(0, 2), be((c.rate || 48000) * 65536 > 0xffffffff ? 0xffff0000 : (c.rate || 48000) * 65536, 4)]);
    if (co === 'opus') {
      const d = new Uint8Array(11); d[0] = 0; d[1] = c.channels || 2; new DataView(d.buffer).setUint16(2, 312); new DataView(d.buffer).setUint32(4, c.rate || 48000); d[10] = 0;
      return box('Opus', base, box('dOps', d));
    }
    if (co.startsWith('mp4a')) return box('mp4a', base, esds(c));
    if (co === 'flac') return box('fLaC', base, desc ? full('dfLa', 0, 0, desc) : null);
    return fail('Codec de áudio não suportado no MP4: ' + co);
  }

  function mp4(o) {
    o = o || {};
    const self = { tracks: [], total: 0 };
    if (o.video) track(self.tracks, 'video', o.video);
    if (o.audio) track(self.tracks, 'audio', o.audio);
    if (!self.tracks.length) fail('Informe vídeo e/ou áudio.');
    self.add = (kind, pk) => addPacket(self, kind, pk);
    self.finish = () => {
      const TS = 90000, scale = t => (t.kind === 'audio' ? (t.cfg.rate || 48000) : TS);
      const ftyp = o.brand === 'qt  ' ? box('ftyp', str('qt  '), be(0, 4), str('qt  ')) : box('ftyp', str('isom'), be(512, 4), str('isom'), str('iso2'), str('mp41'), str(self.tracks.some(t => t.kind === 'video' && /^avc/.test(t.cfg.codec)) ? 'avc1' : 'M4A '));
      const mk = mdatOff => {
        // ordem dos pacotes de cada trilha por tempo; amostras na mdat intercaladas em "chunks" de 1 amostra
        const order = []; self.tracks.forEach((t, ti) => t.packets.forEach(p => order.push({ ti, p })));
        order.sort((a, b) => a.p.timeUs - b.p.timeUs || a.ti - b.ti);
        const offs = self.tracks.map(() => []); let pos = mdatOff + 8;
        order.forEach(x => { offs[x.ti].push(pos); pos += x.p.data.length; });
        const traks = self.tracks.map((t, ti) => {
          const sc = scale(t), pk = t.packets, n = pk.length;
          const toT = us => Math.round(us * sc / 1e6);
          // durações a partir da diferença de tempos (a última usa durationUs ou a anterior)
          const du = pk.map((p, i) => (i + 1 < n ? Math.max(1, toT(pk[i + 1].timeUs) - toT(p.timeUs)) : Math.max(1, toT(p.durationUs || (i ? pk[i].timeUs - pk[i - 1].timeUs : 33333)))));
          const total = du.reduce((a, b) => a + b, 0) + toT(pk.length ? pk[0].timeUs : 0), movieDur = Math.round(total * TS / sc);
          const runs = []; du.forEach(d => { const l = runs[runs.length - 1]; if (l && l[1] === d) l[0]++; else runs.push([1, d]); });
          const stts = full('stts', 0, 0, be(runs.length, 4), ...runs.map(r => cat([be(r[0], 4), be(r[1], 4)])));
          const keys = []; pk.forEach((p, i) => { if (p.key) keys.push(i + 1); });
          const stss = t.kind === 'video' && keys.length < n ? full('stss', 0, 0, be(keys.length, 4), ...keys.map(k => be(k, 4))) : null;
          const stsc = full('stsc', 0, 0, be(1, 4), be(1, 4), be(1, 4), be(1, 4));
          const stsz = full('stsz', 0, 0, be(0, 4), be(n, 4), ...pk.map(p => be(p.data.length, 4)));
          const stco = full('stco', 0, 0, be(n, 4), ...offs[ti].map(v => be(v, 4)));
          const stbl = box('stbl', full('stsd', 0, 0, be(1, 4), sampleEntry(t)), stts, stss, stsc, stsz, stco);
          const vid = t.kind === 'video';
          const minf = box('minf', vid ? full('vmhd', 0, 1, new Uint8Array(8)) : full('smhd', 0, 0, new Uint8Array(4)), box('dinf', full('dref', 0, 0, be(1, 4), full('url ', 0, 1))), stbl);
          const mdhd = full('mdhd', 0, 0, be(0, 4), be(0, 4), be(sc, 4), be(total, 4), be(0x55c4, 2), be(0, 2));
          const hdlr = full('hdlr', 0, 0, be(0, 4), str(vid ? 'vide' : 'soun'), new Uint8Array(12), str((vid ? 'VideoHandler' : 'SoundHandler') + '\0'));
          const tkhd = full('tkhd', 0, 3, be(0, 4), be(0, 4), be(ti + 1, 4), be(0, 4), be(movieDur, 4), new Uint8Array(8), be(0, 2), be(0, 2), be(vid ? 0 : 0x0100, 2), be(0, 2), MATRIX, be(vid ? t.cfg.width * 65536 : 0, 4), be(vid ? t.cfg.height * 65536 : 0, 4));
          return { box: box('trak', tkhd, box('mdia', mdhd, hdlr, minf)), dur: movieDur };
        });
        const mdur = Math.max(...traks.map(t => t.dur), 0);
        const mvhd = full('mvhd', 0, 0, be(0, 4), be(0, 4), be(TS, 4), be(mdur, 4), be(0x00010000, 4), be(0x0100, 2), new Uint8Array(10), MATRIX, new Uint8Array(24), be(self.tracks.length + 1, 4));
        return box('moov', mvhd, ...traks.map(t => t.box));
      };
      const order = []; self.tracks.forEach((t, ti) => t.packets.forEach(p => order.push({ ti, p })));
      order.sort((a, b) => a.p.timeUs - b.p.timeUs || a.ti - b.ti);
      const moovLen = mk(0).length, moov = mk(ftyp.length + moovLen);
      const dataLen = order.reduce((s, x) => s + x.p.data.length, 0);
      if (dataLen + 8 > 0xffffffff) fail('Arquivo grande demais para MP4 simples.');
      return cat([ftyp, moov, be(8 + dataLen, 4), str('mdat'), ...order.map(x => x.p.data)]);
    };
    return self;
  }

  /* ================= Ogg (Opus) ================= */
  const OGG_CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); OGG_CRC[i] = r >>> 0; }
  const oggCrc = b => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b[i]) & 255]) >>> 0; return c; };
  function oggPage(serial, seq, flags, granule, packets) {   // packets: lista de Uint8Array (cada um termina na página)
    const lacing = [];
    packets.forEach(p => { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); });
    if (lacing.length > 255) fail('Página Ogg grande demais.');
    const h = new Uint8Array(27 + lacing.length), dv = new DataView(h.buffer);
    h.set(str('OggS')); h[4] = 0; h[5] = flags; dv.setUint32(6, granule % 2 ** 32, true); dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
    dv.setUint32(14, serial, true); dv.setUint32(18, seq, true); h[26] = lacing.length; h.set(lacing, 27);
    const page = cat([h, ...packets]); new DataView(page.buffer).setUint32(22, oggCrc(page), true);
    return page;
  }
  /** Ogg/Opus: o = { audio: { channels, rate, preskip } }; pacotes = Opus brutos (AudioEncoder 'opus'). */
  function ogg(o) {
    o = o || {}; const c = o.audio || {}, self = { tracks: [], total: 0 };
    track(self.tracks, 'audio', Object.assign({ codec: 'opus' }, c));
    self.add = (kind, pk) => addPacket(self, kind, pk);
    self.finish = () => {
      const t = self.tracks[0], ch = c.channels || 2, rate = c.rate || 48000, pre = c.preskip == null ? 312 : c.preskip, serial = 0x52344456;
      const tags = cat([str('OpusTags'), be(0, 0), (() => { const v = utf8('R4 dev (libr4)'), b = new Uint8Array(4 + v.length + 4); new DataView(b.buffer).setUint32(0, v.length, true); b.set(v, 4); return b; })()]);
      const out = [oggPage(serial, 0, 2, 0, [opusHead(ch, rate, pre)]), oggPage(serial, 1, 0, 0, [tags])];
      let seq = 2, gran = 0; const pk = t.packets;
      let batch = [], batchBytes = 0;
      const flush = (last, g) => { if (!batch.length) return; out.push(oggPage(serial, seq++, last ? 4 : 0, g, batch)); batch = []; batchBytes = 0; };
      pk.forEach((p, i) => {
        const samples = Math.round((p.durationUs || 20000) * 48 / 1000);
        gran += samples;
        batch.push(p.data); batchBytes += p.data.length;
        const last = i === pk.length - 1;
        if (last || batch.length >= 50 || batchBytes > 8000) flush(last, gran + pre);
      });
      if (!pk.length) out.push(oggPage(serial, seq++, 4, 0, []));
      return cat(out);
    };
    return self;
  }

  const api = { webm, mp4, ogg, fromChunk, opusHead, oggCrc, concat: cat, str, be };
  if (R4 && R4.module) R4.module('mux', api, {
    title: 'R4.mux', group: 'Mídia',
    description: 'Empacotadores de contêiner feitos à mão: WebM (Matroska com Cues), MP4 (moov antes do mdat, pronto para web) e Ogg/Opus. Recebem os pacotes codificados do WebCodecs e devolvem o arquivo.',
    props: [
      { name: 'webm({video:{codec,width,height,description}, audio:{codec,rate,channels,description}})', type: 'muxer', desc: 'add("video"|"audio", pacote|chunk) e finish() → Uint8Array. Codecs: VP8, VP9, AV1, H.264, Opus.' },
      { name: 'mp4({video, audio})', type: 'muxer', desc: 'H.264 (avcC), H.265, AV1, VP9 + AAC, Opus ou FLAC. Exige o description do codec quando houver.' },
      { name: 'ogg({audio:{channels, rate}})', type: 'muxer', desc: 'Ogg/Opus com CRC-32 de página e granule position.' },
      { name: 'fromChunk(chunk)', type: 'pacote', desc: 'Converte EncodedVideoChunk/EncodedAudioChunk em { data, timeUs, durationUs, key }.' }
    ]
  });
  if (R4) R4.mux = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window.R4 : undefined);
