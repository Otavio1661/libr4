/**
 * ============================================
 * libr4 / audio.js  —  R4 dev
 * ============================================
 * R4.audio: edição de áudio sem bibliotecas. Áudio = { sampleRate, channels: [Float32Array...] } (veja R4.codec).
 *  Processamento (funções puras, devolvem áudio novo): trim, cut, concat, mix, gain, fade, normalize, reverse, pan, speed, stretch,
 *    echo, reverb, compress, filter (passa-baixa/alta/banda, notch, pico, prateleiras), equalizer, silence, removeSilence, peaks.
 *  Entrada e saída: decode (WAV/AIFF próprios; MP3/AAC/OGG/FLAC/WebM/MP4 pelo decodificador do navegador),
 *    encode(áudio, 'wav'|'aiff'|'flac'|'opus'|'ogg'|'webm'|'m4a') → Promise<Blob>, play, record.
 * Formatos que dependem do navegador (AAC/m4a) são detectados: sem suporte, a função rejeita com Error.code = 'unsupported'.
 * ============================================
 */
(function (R4) {
  'use strict';
  const C = (R4 && R4.codec) || (typeof require !== 'undefined' ? require('./codec.js') : null);
  const MX = (R4 && R4.mux) || (typeof require !== 'undefined' ? require('./mux.js') : null);
  const fail = (m, code) => { const e = new Error(m); if (code) e.code = code; throw e; };
  const { audio, frames, copy, remix, resample, level } = C;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const db2g = d => Math.pow(10, d / 20);
  const map = (a, f) => audio(a.sampleRate, a.channels.map(f));
  const idx = (a, s) => clamp(Math.round(s * a.sampleRate), 0, frames(a));

  /* ================= edição ================= */
  /** Mantém só de `from` a `to` (segundos). */
  function trim(a, from, to) {
    const i = idx(a, from || 0), j = to == null ? frames(a) : idx(a, to);
    if (j <= i) fail('Intervalo vazio.');
    return map(a, c => c.slice(i, j));
  }
  /** Remove o trecho de `from` a `to` (segundos). */
  function cut(a, from, to) {
    const i = idx(a, from), j = idx(a, to);
    if (j <= i) return copy(a);
    return map(a, c => { const o = new Float32Array(c.length - (j - i)); o.set(c.subarray(0, i)); o.set(c.subarray(j), i); return o; });
  }
  /** Concatena (mesma taxa; converte canais/taxa se preciso). crossfade em segundos. */
  function concat(list, o) {
    if (!list.length) fail('Nenhum áudio.');
    o = o || {}; const rate = list[0].sampleRate, ch = Math.max(...list.map(x => x.channels.length));
    const parts = list.map(x => remix(x.sampleRate === rate ? x : resample(x, rate), ch));
    const xf = Math.round((o.crossfade || 0) * rate); let total = 0;
    parts.forEach((p, i) => { total += frames(p) - (i ? Math.min(xf, frames(p), frames(parts[i - 1])) : 0); });
    const out = audio(rate, Array.from({ length: ch }, () => new Float32Array(total))); let pos = 0;
    parts.forEach((p, i) => {
      const n = frames(p), f = i ? Math.min(xf, n, frames(parts[i - 1])) : 0;
      for (let c = 0; c < ch; c++) {
        const dst = out.channels[c], src = p.channels[c];
        for (let k = 0; k < f; k++) { const w = (k + 0.5) / f; dst[pos - f + k] = dst[pos - f + k] * Math.cos(w * Math.PI / 2) + src[k] * Math.sin(w * Math.PI / 2); }
        dst.set(src.subarray(f), pos);
      }
      pos += n - f;
    });
    return out;
  }
  /** Mistura faixas: [{ audio, offset (s), gain (dB) }] ou áudios soltos. Soma com limitador suave. */
  function mix(list, o) {
    if (!list.length) fail('Nenhum áudio.');
    const items = list.map(x => (x && x.audio ? x : { audio: x })), rate = items[0].audio.sampleRate, ch = Math.max(...items.map(x => x.audio.channels.length));
    const conv = items.map(x => ({ a: remix(x.audio.sampleRate === rate ? x.audio : resample(x.audio, rate), ch), off: Math.round((x.offset || 0) * rate), g: db2g(x.gain || 0) }));
    const len = Math.max(...conv.map(x => x.off + frames(x.a)));
    const out = audio(rate, Array.from({ length: ch }, () => new Float32Array(len)));
    conv.forEach(x => { for (let c = 0; c < ch; c++) { const d = out.channels[c], s = x.a.channels[c]; for (let i = 0; i < s.length; i++) d[x.off + i] += s[i] * x.g; } });
    if (!o || o.limit !== false) out.channels.forEach(c => { for (let i = 0; i < c.length; i++) { const v = c[i]; if (v > 1 || v < -1) c[i] = Math.tanh(v); } });
    return out;
  }
  const gain = (a, dB) => { const g = db2g(dB); return map(a, c => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; }); };
  /** Fade in/out em segundos; curve 'linear' | 'log' | 'cos'. */
  function fade(a, inS, outS, curve) {
    const sh = { linear: x => x, log: x => x * x, cos: x => 0.5 - 0.5 * Math.cos(Math.PI * x) }[curve || 'cos'] || (x => x);
    return map(a, c => {
      const o = c.slice(), n = o.length, fi = Math.min(n, Math.round((inS || 0) * a.sampleRate)), fo = Math.min(n, Math.round((outS || 0) * a.sampleRate));
      for (let i = 0; i < fi; i++) o[i] *= sh(i / fi);
      for (let i = 0; i < fo; i++) o[n - 1 - i] *= sh(i / fo);
      return o;
    });
  }
  /** Leva o pico para `peakDb` (padrão -1 dBFS). */
  function normalize(a, peakDb) {
    const L = level(a); if (!L.peak) return copy(a);
    return gain(a, (peakDb == null ? -1 : peakDb) - 20 * Math.log10(L.peak));
  }
  const reverse = a => map(a, c => c.slice().reverse());
  /** Balanço de -1 (esquerda) a 1 (direita) para estéreo. */
  function pan(a, p) {
    const s = remix(a, 2), t = (clamp(p, -1, 1) + 1) * Math.PI / 4, l = Math.cos(t) * Math.SQRT2, r = Math.sin(t) * Math.SQRT2;
    return audio(s.sampleRate, [s.channels[0].map(v => v * l), s.channels[1].map(v => v * r)]);
  }
  /** Velocidade com mudança de tom (como disco): fator 2 = dobro e mais agudo. */
  function speed(a, f) {
    if (!(f >= 0.1 && f <= 10)) fail('Fator de velocidade inválido (0,1 a 10).');
    const r = resample(a, Math.round(a.sampleRate / f)); return audio(a.sampleRate, r.channels);
  }
  /** Muda o andamento sem mudar o tom (sobreposição e soma com busca de correlação — WSOLA). */
  function stretch(a, f) {
    if (!(f >= 0.25 && f <= 4)) fail('Fator de andamento inválido (0,25 a 4).');
    const win = Math.round(0.046 * a.sampleRate), hop = win >> 1, search = hop >> 1, hann = new Float32Array(win);
    for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);
    return map(a, c => {
      const n = c.length, outLen = Math.floor(n / f), out = new Float32Array(outLen + win), norm = new Float32Array(outLen + win);
      let prev = 0;
      for (let o = 0, k = 0; o < outLen; o += hop, k++) {
        const nominal = Math.round(o * f); let best = nominal;
        if (k) {   // procura o trecho mais parecido com a continuação natural do anterior
          const target = prev + hop; let bc = -Infinity;
          for (let d = -search; d <= search; d += 2) {
            const s = nominal + d; if (s < 0 || s + win > n) continue;
            let cr = 0; for (let i = 0; i < hop; i += 4) cr += c[target + i] * c[s + i];
            if (cr > bc) { bc = cr; best = s; }
          }
        }
        if (best + win > n) break;
        for (let i = 0; i < win; i++) { out[o + i] += c[best + i] * hann[i]; norm[o + i] += hann[i]; }
        prev = best;
      }
      const r = new Float32Array(outLen); for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-4 ? out[i] / norm[i] : 0;
      return r;
    });
  }
  /** Mesmo tempo, tom mudado em `semitons` (stretch + reamostragem). */
  function pitch(a, semitons) {
    const r = Math.pow(2, semitons / 12);
    if (r === 1) return copy(a);
    const st = stretch(a, 1 / r), rs = resample(audio(st.sampleRate, st.channels), Math.round(a.sampleRate / r));
    const n = frames(a); return audio(a.sampleRate, rs.channels.map(c => { const o = new Float32Array(n); o.set(c.subarray(0, Math.min(n, c.length))); return o; }));
  }
  const silence = (seconds, rate, ch) => audio(rate || 44100, Array.from({ length: ch || 1 }, () => new Float32Array(Math.round(seconds * (rate || 44100)))));

  /* ================= efeitos ================= */
  function echo(a, o) {
    o = Object.assign({ delay: 0.3, feedback: 0.4, mix: 0.5 }, o);
    const d = Math.max(1, Math.round(o.delay * a.sampleRate)), fb = clamp(o.feedback, 0, 0.95), tail = Math.round(a.sampleRate * Math.min(5, o.delay * (Math.log(0.01) / Math.log(Math.max(0.01, fb) || 0.01))));
    return map(a, c => {
      const n = c.length + (fb ? Math.max(0, tail) : d), out = new Float32Array(n), buf = new Float32Array(n);
      for (let i = 0; i < n; i++) { const dry = i < c.length ? c[i] : 0, w = i >= d ? buf[i - d] : 0; buf[i] = dry + w * fb; out[i] = dry * (1 - o.mix * 0.5) + w * o.mix; }
      return out;
    });
  }
  /** Reverberação de Schroeder (4 filtros de pente + 2 passa-tudo). */
  function reverb(a, o) {
    o = Object.assign({ room: 0.6, damp: 0.4, mix: 0.3 }, o);
    const r = a.sampleRate / 44100, combs = [1116, 1188, 1277, 1356].map(x => Math.round(x * r)), aps = [225, 556].map(x => Math.round(x * r));
    const fb = 0.7 + clamp(o.room, 0, 1) * 0.28, tailN = Math.round(a.sampleRate * (0.5 + o.room * 2.5));
    return map(a, (c, ch) => {
      const n = c.length + tailN, out = new Float32Array(n), spread = ch * 23;
      let sum = new Float32Array(n);
      combs.forEach(len0 => {
        const len = len0 + spread, buf = new Float32Array(len); let p = 0, lp = 0;
        for (let i = 0; i < n; i++) { const x = i < c.length ? c[i] : 0, y = buf[p]; lp = y * (1 - o.damp) + lp * o.damp; buf[p] = x + lp * fb; p = (p + 1) % len; sum[i] += y * 0.25; }
      });
      aps.forEach(len0 => {
        const len = len0 + spread, buf = new Float32Array(len); let p = 0; const nx = new Float32Array(n);
        for (let i = 0; i < n; i++) { const b = buf[p], x = sum[i]; buf[p] = x + b * 0.5; nx[i] = b - x * 0.5 + 0; p = (p + 1) % len; }
        sum = nx;
      });
      for (let i = 0; i < n; i++) out[i] = (i < c.length ? c[i] : 0) * (1 - o.mix) + sum[i] * o.mix * 3;
      return out;
    });
  }
  /** Compressor simples (RMS por amostra com ataque/soltura). */
  function compress(a, o) {
    o = Object.assign({ threshold: -18, ratio: 4, attack: 0.01, release: 0.12, makeup: 0 }, o);
    const ca = Math.exp(-1 / (o.attack * a.sampleRate)), cr = Math.exp(-1 / (o.release * a.sampleRate)), mk = db2g(o.makeup);
    const n = frames(a), env = new Float32Array(n); let e = 0;
    for (let i = 0; i < n; i++) { let m = 0; for (const c of a.channels) m = Math.max(m, Math.abs(c[i])); e = m > e ? ca * e + (1 - ca) * m : cr * e + (1 - cr) * m; env[i] = e; }
    return map(a, c => { const out = new Float32Array(n); for (let i = 0; i < n; i++) { const dB = 20 * Math.log10(env[i] + 1e-9), over = dB - o.threshold, g = over > 0 ? -over * (1 - 1 / o.ratio) : 0; out[i] = c[i] * db2g(g) * mk; } return out; });
  }

  /* biquad (receitas do "Audio EQ Cookbook") */
  function biquadCoef(type, rate, f, q, gdb) {
    const w = 2 * Math.PI * clamp(f, 10, rate / 2 - 10) / rate, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * (q || Math.SQRT1_2)), A = Math.pow(10, (gdb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'notch': b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'peak': b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break;
      case 'lowshelf': { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * cs + s); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s); a0 = (A + 1) + (A - 1) * cs + s; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s; break; }
      case 'highshelf': { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s); a0 = (A + 1) - (A - 1) * cs + s; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s; break; }
      default: return fail('Tipo de filtro desconhecido: ' + type);
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  /** Filtro: type lowpass|highpass|bandpass|notch|peak|lowshelf|highshelf; freq Hz; q; gain dB (peak/shelf). */
  function filter(a, type, freq, o) {
    o = o || {}; const [b0, b1, b2, a1, a2] = biquadCoef(type, a.sampleRate, freq, o.q, o.gain);
    return map(a, c => { const out = new Float32Array(c.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < c.length; i++) { const x = c[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y; } return out; });
  }
  const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  /** Equalizador gráfico: gains em dB para as faixas (padrão 10 faixas: 60 Hz … 16 kHz). */
  function equalizer(a, gains, freqs) {
    freqs = freqs || EQ_BANDS; let r = a;
    gains.forEach((g, i) => { if (g && freqs[i] && freqs[i] < a.sampleRate / 2 - 100) r = filter(r, i === 0 ? 'lowshelf' : i === gains.length - 1 ? 'highshelf' : 'peak', freqs[i], { q: 1.1, gain: g }); });
    return r;
  }
  /** Trechos de silêncio: [{ from, to }] em segundos (abaixo de `threshold` dBFS por pelo menos `min` s). */
  function findSilence(a, o) {
    o = Object.assign({ threshold: -50, min: 0.4 }, o); const th = db2g(o.threshold), n = frames(a), minN = Math.round(o.min * a.sampleRate), out = []; let s = -1;
    for (let i = 0; i < n; i++) {
      let m = 0; for (const c of a.channels) { const v = Math.abs(c[i]); if (v > m) m = v; }
      if (m < th) { if (s < 0) s = i; } else if (s >= 0) { if (i - s >= minN) out.push({ from: s / a.sampleRate, to: i / a.sampleRate }); s = -1; }
    }
    if (s >= 0 && n - s >= minN) out.push({ from: s / a.sampleRate, to: n / a.sampleRate });
    return out;
  }
  /** Remove (ou encurta para `keep` s) os silêncios. */
  function removeSilence(a, o) {
    o = Object.assign({ keep: 0.1 }, o); const list = findSilence(a, o); let r = a, off = 0;
    list.forEach(s => { const from = s.from + o.keep / 2 - off, to = s.to - o.keep / 2 - off; if (to > from) { r = cut(r, from, to); off += to - from; } });
    return r;
  }
  /** Picos por coluna para desenhar a forma de onda: Float32Array [min0, max0, min1, max1...]. */
  function peaks(a, n) {
    const len = frames(a), out = new Float32Array(n * 2), step = len / n;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * step), e = Math.max(s + 1, Math.min(len, Math.floor((i + 1) * step))); let mn = 1, mx = -1;
      for (const c of a.channels) for (let k = s; k < e; k++) { const v = c[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      out[i * 2] = len ? mn : 0; out[i * 2 + 1] = len ? mx : 0;
    }
    return out;
  }

  /* ================= entrada: decodificar ================= */
  const toBytes = async src => {
    if (src instanceof Uint8Array) return src;
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (typeof Blob !== 'undefined' && src instanceof Blob) { if (src.size > 300 * 1024 * 1024) fail('Arquivo grande demais (máximo 300 MB).'); return new Uint8Array(await src.arrayBuffer()); }
    return fail('Entrada inválida: use File, Blob, ArrayBuffer ou Uint8Array.');
  };
  /** Decodifica qualquer áudio suportado (e o áudio de vídeos). Devolve Promise<áudio>. */
  async function decode(src, o) {
    o = o || {}; const u = await toBytes(src);
    const kind = R4 && R4.demux ? R4.demux.sniff(u) : '';
    if (kind === 'wav') return C.decodeWAV(u);
    if (kind === 'aiff') return C.decodeAIFF(u);
    const Ctx = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null;
    if (!Ctx) fail('Este navegador não consegue decodificar áudio.', 'unsupported');
    let buf;
    try { buf = await new Ctx(1, 1, o.sampleRate || 48000).decodeAudioData(u.slice().buffer); }
    catch (e) { fail('Não foi possível decodificar este arquivo de áudio (' + (kind || 'formato desconhecido') + ').', 'decode'); }
    if (buf.length * buf.numberOfChannels > C.MAX_SAMPLES) fail('Áudio longo demais para processar.');
    return audio(buf.sampleRate, Array.from({ length: Math.min(8, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice()));
  }

  /* ================= saída: codificar ================= */
  const FORMATS = { wav: ['audio/wav', 'wav'], aiff: ['audio/aiff', 'aiff'], flac: ['audio/flac', 'flac'], opus: ['audio/webm', 'webm'], webm: ['audio/webm', 'webm'], ogg: ['audio/ogg', 'ogg'], m4a: ['audio/mp4', 'm4a'], mp4: ['audio/mp4', 'm4a'] };
  /** Formatos que este navegador consegue gravar agora: ['wav','aiff','flac', ...]. */
  async function formats() {
    const out = ['wav', 'aiff', 'flac'];
    if (typeof AudioEncoder === 'function') {
      const sup = async c => { try { return (await AudioEncoder.isConfigSupported({ codec: c, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported; } catch (e) { return false; } };
      if (await sup('opus')) out.push('opus', 'ogg');
      if (await sup('mp4a.40.2')) out.push('m4a');
    }
    return out;
  }
  /** Codifica com o AudioEncoder do navegador e devolve { packets, description, rate, channels, codec }. */
  async function webcodecsEncode(a, codec, o) {
    if (typeof AudioEncoder !== 'function') fail((R4.video && R4.video.support ? R4.video.support().message : '') || 'Este navegador não tem AudioEncoder.', 'unsupported');
    const rate = codec === 'opus' ? 48000 : (a.sampleRate <= 48000 ? a.sampleRate : 48000), src = a.sampleRate === rate ? a : resample(a, rate), ch = Math.min(2, src.channels.length), s = remix(src, ch);
    const cfg = { codec, sampleRate: rate, numberOfChannels: ch, bitrate: (o && o.bitrate) || (codec === 'opus' ? 128000 : 160000) };
    let sup = false; try { sup = (await AudioEncoder.isConfigSupported(cfg)).supported; } catch (e) { sup = false; }
    if (!sup) fail('Este navegador não consegue codificar ' + (codec === 'opus' ? 'Opus' : 'AAC') + '.', 'unsupported');
    const packets = []; let description = null, err = null;
    const enc = new AudioEncoder({ output: (c, m) => { if (m && m.decoderConfig && m.decoderConfig.description) description = new Uint8Array(m.decoderConfig.description.buffer ? m.decoderConfig.description.buffer.slice(m.decoderConfig.description.byteOffset, m.decoderConfig.description.byteOffset + m.decoderConfig.description.byteLength) : m.decoderConfig.description); packets.push(MX.fromChunk(c)); }, error: e => { err = e; } });
    enc.configure(cfg);
    const n = frames(s), step = codec === 'opus' ? 960 : 1024;
    for (let off = 0; off < n && !err; off += step) {
      const m = Math.min(step, n - off), buf = new Float32Array(m * ch);
      for (let c = 0; c < ch; c++) buf.set(s.channels[c].subarray(off, off + m), c * m);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: m, numberOfChannels: ch, timestamp: Math.round(off * 1e6 / rate), data: buf });
      enc.encode(ad); ad.close();
      if (enc.encodeQueueSize > 64) await new Promise(r => setTimeout(r, 0));
    }
    await enc.flush(); enc.close();
    if (err) fail('Falha ao codificar: ' + err.message, 'encode');
    return { packets, description, rate, channels: ch, codec };
  }
  /** Codifica para o formato pedido. opts: { bits (wav/aiff/flac), bitrate (opus/aac) }. Promise<Blob>. */
  async function encode(a, format, o) {
    o = o || {}; format = String(format || 'wav').toLowerCase().replace(/^\./, '');
    const f = FORMATS[format]; if (!f) fail('Formato de áudio desconhecido: ' + format, 'format');
    let bytes;
    if (format === 'wav') bytes = C.encodeWAV(a, { bits: o.bits || 16, float: o.float });
    else if (format === 'aiff') bytes = C.encodeAIFF(a, { bits: o.bits === 24 ? 24 : 16 });
    else if (format === 'flac') bytes = C.encodeFLAC(a, { bits: o.bits === 24 ? 24 : 16 });
    else if (format === 'ogg') { const r = await webcodecsEncode(a, 'opus', o), m = MX.ogg({ audio: { channels: r.channels, rate: 48000 } }); r.packets.forEach(p => m.add('audio', p)); bytes = m.finish(); }
    else if (format === 'opus' || format === 'webm') { const r = await webcodecsEncode(a, 'opus', o), m = MX.webm({ audio: { codec: 'opus', rate: 48000, channels: r.channels } }); r.packets.forEach(p => m.add('audio', p)); bytes = m.finish(); }
    else { const r = await webcodecsEncode(a, 'mp4a.40.2', o), m = MX.mp4({ audio: { codec: 'mp4a.40.2', rate: r.rate, channels: r.channels, description: r.description } }); r.packets.forEach(p => m.add('audio', p)); bytes = m.finish(); }
    return new Blob([bytes], { type: f[0] });
  }

  /* ================= reprodução e gravação ================= */
  /** Toca o áudio (ou um trecho). Devolve { stop(), position(), ended: Promise }. */
  function play(a, o) {
    o = o || {}; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) fail('Este navegador não toca áudio.', 'unsupported');
    const ctx = new AC(), buf = ctx.createBuffer(a.channels.length, frames(a), a.sampleRate);
    a.channels.forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = !!o.loop;
    const from = clamp(o.from || 0, 0, buf.duration), to = o.to == null ? buf.duration : clamp(o.to, from, buf.duration);
    if (o.loop) { src.loopStart = from; src.loopEnd = to; }
    let done; const ended = new Promise(r => { done = r; });
    src.connect(ctx.destination); src.onended = () => { try { ctx.close(); } catch (e) { /* ignora */ } done(); };
    ctx.resume().then(() => src.start(0, from, o.loop ? undefined : to - from)).catch(() => done());
    const t0 = ctx.currentTime;
    return { stop() { try { src.stop(); } catch (e) { /* já parou */ } }, position() { const t = ctx.currentTime - t0; return o.loop ? from + (t % (to - from || 1)) : Math.min(to, from + t); }, ended };
  }
  /** Grava o microfone. Devolve { stop(): Promise<áudio>, cancel() }. Exige HTTPS e permissão do usuário. */
  async function record(o) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') fail('Este navegador não grava áudio.', 'unsupported');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ echoCancellation: true, noiseSuppression: true }, o && o.constraints) });
    const rec = new MediaRecorder(stream), parts = []; rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; }); rec.start(250);
    const release = () => stream.getTracks().forEach(t => t.stop());
    return { async stop() { if (rec.state !== 'inactive') rec.stop(); await stopped; release(); return decode(new Blob(parts, { type: rec.mimeType })); }, cancel() { if (rec.state !== 'inactive') rec.stop(); release(); }, get state() { return rec.state; } };
  }

  const api = { trim, cut, concat, mix, gain, fade, normalize, reverse, pan, speed, stretch, pitch, silence, echo, reverb, compress, filter, equalizer, findSilence, removeSilence, peaks, level, decode, encode, encodePackets: webcodecsEncode, formats, play, record, remix, resample, EQ_BANDS };
  if (R4 && R4.module) R4.module('audio', api, {
    title: 'R4.audio', group: 'Mídia',
    description: 'Edição de áudio sem bibliotecas: cortar, juntar, misturar, ganho, fade, normalizar, inverter, velocidade, andamento e tom, eco, reverb, compressor, filtros e equalizador, silêncio, e conversão entre WAV, AIFF, FLAC, Opus (WebM/Ogg) e AAC (quando o navegador permite).',
    props: [
      { name: 'decode(File|Blob|ArrayBuffer)', type: 'Promise<áudio>', desc: 'WAV/AIFF pelo decodificador próprio; MP3, AAC, OGG, FLAC, WebM e MP4 pelo navegador. Limite de 300 MB.' },
      { name: 'encode(áudio, formato, {bits, bitrate})', type: 'Promise<Blob>', desc: 'wav, aiff, flac (próprios, sem perdas), opus/webm, ogg (Opus) e m4a (AAC se o navegador tiver codificador). Rejeita com code "unsupported" quando não dá.' },
      { name: 'trim(a, de, até) / cut(a, de, até) / concat([a, b], {crossfade}) / mix([{audio, offset, gain}])', type: 'áudio', desc: 'Edição por tempo em segundos.' },
      { name: 'gain(a, dB) / fade(a, entra, sai, curva) / normalize(a, pico) / reverse(a) / pan(a, -1..1)', type: 'áudio', desc: 'Volume e forma.' },
      { name: 'speed(a, fator) / stretch(a, fator) / pitch(a, semitons)', type: 'áudio', desc: 'speed muda tom e duração; stretch muda só a duração (WSOLA); pitch muda só o tom.' },
      { name: 'echo / reverb / compress / filter(a, tipo, hz, {q, gain}) / equalizer(a, [dB...])', type: 'áudio', desc: 'Efeitos e filtros biquad (lowpass, highpass, bandpass, notch, peak, lowshelf, highshelf).' },
      { name: 'findSilence / removeSilence / peaks(a, n) / level(a)', type: 'análise', desc: 'Silêncios, picos para forma de onda e nível (pico, RMS).' },
      { name: 'play(a, {from, to, loop}) / record()', type: 'controle', desc: 'Toca com stop()/position(); grava o microfone (permissão do usuário).' },
      { name: 'formats()', type: 'Promise<string[]>', desc: 'Formatos que este navegador consegue gravar agora.' }
    ]
  });
  if (R4) R4.audio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window.R4 : undefined);
