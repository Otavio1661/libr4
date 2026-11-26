/**
 * ============================================
 * libr4 / gfx.js  —  R4 dev
 * ============================================
 * R4.gfx: processamento de imagem/vídeo quadro a quadro, sem bibliotecas. Trabalha em { data: Uint8ClampedArray RGBA, width, height }
 * (um ImageData serve) e altera o objeto recebido, devolvendo-o.
 *  Chave: chromaKey (com supressão de spill).
 *  Cor: grade (lift/gamma/gain, curvas RGB, saturação, contraste, temperatura, HSL secundário, LUT 3D), parseCube, applyLUT, curveTable.
 *  Efeitos: vignette, sharpen, blur, pixelate, grain, invert.
 *  Medição: scopes (histograma, forma de onda, parada RGB, vectorscópio) e drawScope.
 *  Movimento: gray, trackPoint, trackPlanar, homography, applyH, estimateMotion, smoothPath (estabilização).
 * ============================================
 * Cores: '#rrggbb', [r,g,b] (0-255) ou nome simples.
 * ============================================
 */
(function (R4) {
  'use strict';
  const fail = m => { throw new Error(m); };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const chk = img => { if (!img || !img.data || !(img.width > 0) || img.data.length < img.width * img.height * 4) fail('Imagem inválida.'); return img; };
  const NAMED = { green: [0, 255, 0], blue: [0, 0, 255], red: [255, 0, 0], white: [255, 255, 255], black: [0, 0, 0] };
  function rgb(c) {
    if (Array.isArray(c)) return c.slice(0, 3);
    if (typeof c === 'string') {
      if (NAMED[c]) return NAMED[c].slice();
      const m = /^#?([0-9a-f]{6})$/i.exec(c); if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
    }
    return fail('Cor inválida: ' + c);
  }
  const smooth = (a, b, x) => { const t = clamp((x - a) / Math.max(1e-6, b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ================= chave de croma ================= */
  /** {color:'#00ff00', tolerance:0.3, softness:0.15, spill:0.7} — tolerance/softness em 0..1 da distância de croma; spill 0..1. */
  function chromaKey(img, o) {
    chk(img); o = Object.assign({ color: '#00ff00', tolerance: 0.3, softness: 0.15, spill: 0.7 }, o);
    const k = rgb(o.color), d = img.data, n = img.width * img.height;
    const cb0 = -0.168736 * k[0] - 0.331264 * k[1] + 0.5 * k[2], cr0 = 0.5 * k[0] - 0.418688 * k[1] - 0.081312 * k[2];
    const dom = k[0] >= k[1] && k[0] >= k[2] ? 0 : k[1] >= k[2] ? 1 : 2, o1 = (dom + 1) % 3, o2 = (dom + 2) % 3;
    const tol = o.tolerance * 181, soft = Math.max(0.5, o.softness * 181);
    for (let i = 0; i < n; i++) {
      const p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2];
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b, dist = Math.hypot(cb - cb0, cr - cr0);
      const a = smooth(tol, tol + soft, dist);
      d[p + 3] = Math.round(d[p + 3] * a);
      if (o.spill > 0 && a > 0) {   // tira o reflexo da cor da chave nas bordas e no resto da imagem
        const lim = (d[p + o1] + d[p + o2]) / 2;
        if (d[p + dom] > lim) d[p + dom] = Math.round(d[p + dom] - (d[p + dom] - lim) * o.spill);
      }
    }
    return img;
  }

  /* ================= correção de cor ================= */
  /** Curva suave (spline monótona) por pontos [[x,y],...] em 0..1 → Uint8Array(256). */
  function curveTable(points) {
    const p = (points && points.length ? points : [[0, 0], [1, 1]]).slice().sort((a, b) => a[0] - b[0]), n = p.length, t = new Uint8Array(256);
    const dx = [], m = [], s = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; s[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
    m[0] = s[0] || 0; m[n - 1] = s[n - 2] || 0;
    for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
    for (let i = 0; i < n - 1; i++) { if (s[i] === 0) { m[i] = 0; m[i + 1] = 0; } else { const a = m[i] / s[i], b = m[i + 1] / s[i], h = a * a + b * b; if (h > 9) { const q = 3 / Math.sqrt(h); m[i] = q * a * s[i]; m[i + 1] = q * b * s[i]; } } }
    for (let v = 0; v < 256; v++) {
      const x = v / 255; let y;
      if (x <= p[0][0]) y = p[0][1]; else if (x >= p[n - 1][0]) y = p[n - 1][1];
      else { let i = 0; while (i < n - 2 && x > p[i + 1][0]) i++; const h = dx[i], u = (x - p[i][0]) / h, u2 = u * u, u3 = u2 * u; y = (2 * u3 - 3 * u2 + 1) * p[i][1] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * p[i + 1][1] + (u3 - u2) * h * m[i + 1]; }
      t[v] = Math.round(clamp(y, 0, 1) * 255);
    }
    return t;
  }
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
    if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return [h, s, l];
  }
  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) { const v = l * 255; return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  /** Lê um arquivo .cube (LUT 3D) → { size, data: Float32Array(size^3*3), title }. */
  function parseCube(text) {
    let size = 0, title = '', dmin = [0, 0, 0], dmax = [1, 1, 1]; const vals = [];
    String(text).split(/\r?\n/).forEach(line => {
      line = line.replace(/#.*/, '').trim(); if (!line) return;
      let m;
      if ((m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line))) size = +m[1];
      else if (/^LUT_1D_SIZE/i.test(line)) fail('LUT 1D não é suportada (use 3D).');
      else if ((m = /^TITLE\s+"?(.*?)"?$/i.exec(line))) title = m[1];
      else if ((m = /^DOMAIN_MIN\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(line))) dmin = [+m[1], +m[2], +m[3]];
      else if ((m = /^DOMAIN_MAX\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(line))) dmax = [+m[1], +m[2], +m[3]];
      else if (/^[-+0-9.]/.test(line)) { const p = line.split(/\s+/).map(Number); if (p.length >= 3 && p.every(isFinite)) vals.push(p[0], p[1], p[2]); }
    });
    if (size < 2 || size > 128) fail('LUT sem LUT_3D_SIZE válido (2 a 128).');
    if (vals.length !== size * size * size * 3) fail('LUT incompleta: esperava ' + size * size * size + ' linhas, achei ' + vals.length / 3 + '.');
    const data = new Float32Array(vals);
    for (let i = 0; i < data.length; i++) { const c = i % 3; data[i] = (data[i] - dmin[c]) / (dmax[c] - dmin[c]); }
    return { size, data, title };
  }
  /** Aplica LUT 3D (interpolação trilinear). strength 0..1. */
  function applyLUT(img, lut, strength) {
    chk(img); const N = lut.size, L = lut.data, d = img.data, n = img.width * img.height, s = strength == null ? 1 : strength, M = N - 1;
    for (let i = 0; i < n; i++) {
      const p = i * 4, r = d[p] / 255 * M, g = d[p + 1] / 255 * M, b = d[p + 2] / 255 * M;
      const r0 = Math.min(M - 1, r | 0), g0 = Math.min(M - 1, g | 0), b0 = Math.min(M - 1, b | 0), fr = r - r0, fg = g - g0, fb = b - b0;
      const at = (ri, gi, bi, c) => L[((bi * N + gi) * N + ri) * 3 + c];
      for (let c = 0; c < 3; c++) {
        const c00 = at(r0, g0, b0, c) * (1 - fr) + at(r0 + 1, g0, b0, c) * fr, c10 = at(r0, g0 + 1, b0, c) * (1 - fr) + at(r0 + 1, g0 + 1, b0, c) * fr;
        const c01 = at(r0, g0, b0 + 1, c) * (1 - fr) + at(r0 + 1, g0, b0 + 1, c) * fr, c11 = at(r0, g0 + 1, b0 + 1, c) * (1 - fr) + at(r0 + 1, g0 + 1, b0 + 1, c) * fr;
        const v = ((c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb) * 255;
        d[p + c] = d[p + c] * (1 - s) + v * s;
      }
    }
    return img;
  }
  /**
   * Correção de cor. Opções (todas opcionais):
   *  lift/gamma/gain: [r,g,b] (lift -0.5..0.5 soma nas sombras; gamma 0.5..2 (1 = igual); gain 0..2 multiplica as luzes),
   *  exposure (EV), contrast (-1..1), saturation (0..2), temperature (-1 frio..1 quente), tint (-1..1),
   *  curves: {master, r, g, b} (listas de pontos [x,y] 0..1), hsl: [{hue, range, hueShift, satShift, lumShift}] (secundária por matiz em graus),
   *  lut: LUT do parseCube, lutStrength.
   */
  function grade(img, o) {
    chk(img); o = o || {};
    const lift = o.lift || [0, 0, 0], gamma = o.gamma || [1, 1, 1], gain = o.gain || [1, 1, 1], ev = Math.pow(2, o.exposure || 0), ct = o.contrast || 0, tp = o.temperature || 0, tn = o.tint || 0;
    const cm = o.curves && o.curves.master ? curveTable(o.curves.master) : null, cc = ['r', 'g', 'b'].map(k => (o.curves && o.curves[k] ? curveTable(o.curves[k]) : null));
    const tab = [0, 1, 2].map(c => {
      const t = new Uint8Array(256), gn = gain[c] * ev * (c === 0 ? 1 + tp * 0.25 : c === 2 ? 1 - tp * 0.25 : 1 - tn * 0.15) * (c === 1 ? 1 : 1), gm = 1 / Math.max(0.05, gamma[c]);
      for (let v = 0; v < 256; v++) {
        let x = v / 255; x = x * gn; x = x + lift[c] * (1 - x); x = Math.pow(Math.max(0, x), gm);
        if (ct) x = clamp((x - 0.5) * (1 + ct * 1.5) + 0.5, 0, 2);
        let q = Math.round(clamp(x, 0, 1) * 255); if (cc[c]) q = cc[c][q]; if (cm) q = cm[q];
        t[v] = q;
      }
      return t;
    });
    const sat = o.saturation == null ? 1 : o.saturation, hsl = o.hsl && o.hsl.length ? o.hsl : null, d = img.data, n = img.width * img.height;
    for (let i = 0; i < n; i++) {
      const p = i * 4; let r = tab[0][d[p]], g = tab[1][d[p + 1]], b = tab[2][d[p + 2]];
      if (sat !== 1) { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat; }
      if (hsl) {
        const [h, s, l] = rgb2hsl(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)); let H = h, S = s, Lm = l, hit = false;
        hsl.forEach(q => {
          const dh = Math.abs(((h - q.hue + 540) % 360) - 180), w = 1 - smooth(0, (q.range || 30), dh) * 1;  // 1 = centro
          const wt = dh >= (q.range || 30) ? 0 : 1 - smooth(0, q.range || 30, dh); if (wt <= 0 || s < 0.05) return;
          H += (q.hueShift || 0) * wt; S = clamp(S * (1 + (q.satShift || 0) * wt), 0, 1); Lm = clamp(Lm + (q.lumShift || 0) * wt, 0, 1); hit = true; void w;
        });
        if (hit) { const c = hsl2rgb(H, S, Lm); r = c[0]; g = c[1]; b = c[2]; }
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = b;
    }
    if (o.lut) applyLUT(img, o.lut, o.lutStrength);
    return img;
  }

  /* ================= efeitos ================= */
  function invert(img) { chk(img); const d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } return img; }
  /** Vinheta: amount 0..1, softness 0..1. */
  function vignette(img, o) {
    chk(img); o = Object.assign({ amount: 0.5, softness: 0.5 }, o); const w = img.width, h = img.height, d = img.data, cx = w / 2, cy = h / 2, md = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - cx, y - cy) / md, k = 1 - o.amount * smooth(1 - o.softness - 0.3, 1.0, r), p = (y * w + x) * 4; d[p] *= k; d[p + 1] *= k; d[p + 2] *= k;
    }
    return img;
  }
  /** Desfoque (3 passadas de caixa ≈ gaussiano). radius em pixels. */
  function blur(img, radius) {
    chk(img); const r = Math.round(radius); if (r < 1) return img; const w = img.width, h = img.height, d = img.data, tmp = new Uint8ClampedArray(d.length);
    const pass = (src, dst, horiz) => {
      const len = horiz ? w : h, lines = horiz ? h : w, stride = horiz ? 4 : w * 4, lstride = horiz ? w * 4 : 4, win = 2 * r + 1;
      for (let l = 0; l < lines; l++) {
        const base = l * lstride;
        for (let c = 0; c < 4; c++) {
          let sum = 0; for (let k = -r; k <= r; k++) sum += src[base + clamp(k, 0, len - 1) * stride + c];
          for (let i = 0; i < len; i++) { dst[base + i * stride + c] = sum / win; sum += src[base + clamp(i + r + 1, 0, len - 1) * stride + c] - src[base + clamp(i - r, 0, len - 1) * stride + c]; }
        }
      }
    };
    for (let k = 0; k < 3; k++) { pass(d, tmp, true); pass(tmp, d, false); }
    return img;
  }
  /** Nitidez (máscara de convolução 3x3). amount 0..2. */
  function sharpen(img, amount) {
    chk(img); const a = amount == null ? 1 : amount, w = img.width, h = img.height, src = img.data.slice(), d = img.data;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) { const v = src[p + c] * (1 + 4 * a) - a * (src[p - 4 + c] + src[p + 4 + c] + src[p - w * 4 + c] + src[p + w * 4 + c]); d[p + c] = v; }
    }
    return img;
  }
  function pixelate(img, size) {
    chk(img); const s = Math.max(1, Math.round(size)), w = img.width, h = img.height, d = img.data;
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
      let r = 0, g = 0, b = 0, cnt = 0; const ye = Math.min(h, y + s), xe = Math.min(w, x + s);
      for (let j = y; j < ye; j++) for (let i = x; i < xe; i++) { const p = (j * w + i) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; cnt++; }
      r /= cnt; g /= cnt; b /= cnt;
      for (let j = y; j < ye; j++) for (let i = x; i < xe; i++) { const p = (j * w + i) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b; }
    }
    return img;
  }
  /** Granulado de filme. amount 0..1, seed muda por quadro. */
  function grain(img, amount, seed) {
    chk(img); const d = img.data, k = (amount == null ? 0.2 : amount) * 80; let s = (seed || 1) >>> 0 || 1;
    for (let i = 0; i < d.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const v = (s / 4294967296 - 0.5) * k; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
    return img;
  }

  /* ================= scopes ================= */
  /** Mede um quadro. Devolve { histogram:{r,g,b,luma}, waveform:{w, data}, parade:{w, r,g,b}, vectorscope:{size, data} } com contagens. */
  function scopes(img, o) {
    chk(img); o = Object.assign({ width: 256, step: 1 }, o);
    const W = img.width, H = img.height, d = img.data, SW = o.width, hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256) };
    const wave = new Uint32Array(SW * 256), pr = new Uint32Array(SW * 256), pg = new Uint32Array(SW * 256), pb = new Uint32Array(SW * 256), vs = new Uint32Array(256 * 256);
    for (let y = 0; y < H; y += o.step) for (let x = 0; x < W; x += o.step) {
      const p = (y * W + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2], l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b), col = Math.min(SW - 1, (x * SW / W) | 0);
      hist.r[r]++; hist.g[g]++; hist.b[b]++; hist.luma[l]++; wave[(255 - l) * SW + col]++;
      pr[(255 - r) * SW + col]++; pg[(255 - g) * SW + col]++; pb[(255 - b) * SW + col]++;
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b, vx = clamp(Math.round(128 + cb), 0, 255), vy = clamp(Math.round(127 - cr), 0, 255); vs[vy * 256 + vx]++;
    }
    return { histogram: hist, waveform: { w: SW, data: wave }, parade: { w: SW, r: pr, g: pg, b: pb }, vectorscope: { size: 256, data: vs } };
  }
  /** Desenha um scope num canvas 2D (ctx, tamanho w×h). kind: 'histogram' | 'waveform' | 'parade' | 'vectorscope'. */
  function drawScope(ctx, kind, sc, w, h) {
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, w, h);
    const grid = () => { ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1; for (let i = 0; i <= 4; i++) { const y = Math.round(i * (h - 1) / 4) + .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); } };
    const plot = (arr, cols, color) => {
      let mx = 1; for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
      const img = ctx.createImageData(w, h), dd = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = arr[((y * 256 / h) | 0) * cols + ((x * cols / w) | 0)]; if (!v) continue;
        const a = Math.min(255, Math.round(Math.sqrt(v / mx) * 400)), p = (y * w + x) * 4; dd[p] = color[0]; dd[p + 1] = color[1]; dd[p + 2] = color[2]; dd[p + 3] = a;
      }
      return img;
    };
    const layer = (img) => { const c = (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(img.width, img.height) : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })); c.getContext('2d').putImageData(img, 0, 0); ctx.drawImage(c, 0, 0); };
    if (kind === 'histogram') {
      const hs = sc.histogram; let mx = 1; ['r', 'g', 'b'].forEach(k => { for (let i = 1; i < 255; i++) if (hs[k][i] > mx) mx = hs[k][i]; });
      ctx.globalCompositeOperation = 'lighter';
      [['r', '#ff3b3b'], ['g', '#3bff5a'], ['b', '#3b7bff']].forEach(([k, col]) => { ctx.fillStyle = col; for (let i = 0; i < 256; i++) { const bh = Math.min(1, hs[k][i] / mx) * (h - 2), x0 = i * w / 256; ctx.globalAlpha = 0.55; ctx.fillRect(x0, h - bh, Math.max(1, w / 256), bh); } });
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; return;
    }
    if (kind === 'waveform') { layer(plot(sc.waveform.data, sc.waveform.w, [80, 255, 120])); grid(); return; }
    if (kind === 'parade') {
      const p = sc.parade, third = Math.floor(w / 3);
      [['r', [255, 70, 70]], ['g', [70, 255, 100]], ['b', [80, 130, 255]]].forEach(([k, col], i) => {
        const sub = { }; void sub; const img = (() => { const iw = third, im = ctx.createImageData(iw, h), dd = im.data, arr = p[k]; let mx = 1; for (let q = 0; q < arr.length; q++) if (arr[q] > mx) mx = arr[q];
          for (let y = 0; y < h; y++) for (let x = 0; x < iw; x++) { const v = arr[((y * 256 / h) | 0) * p.w + ((x * p.w / iw) | 0)]; if (!v) continue; const pp = (y * iw + x) * 4; dd[pp] = col[0]; dd[pp + 1] = col[1]; dd[pp + 2] = col[2]; dd[pp + 3] = Math.min(255, Math.round(Math.sqrt(v / mx) * 400)); }
          return im; })();
        const c = (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(third, h) : Object.assign(document.createElement('canvas'), { width: third, height: h })); c.getContext('2d').putImageData(img, 0, 0); ctx.drawImage(c, i * third, 0);
      });
      grid(); return;
    }
    if (kind === 'vectorscope') {
      const s = Math.min(w, h), ox = (w - s) / 2, oy = (h - s) / 2; ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.arc(w / 2, h / 2, s / 2 - 1, 0, 6.2832); ctx.moveTo(ox, h / 2); ctx.lineTo(ox + s, h / 2); ctx.moveTo(w / 2, oy); ctx.lineTo(w / 2, oy + s); ctx.stroke();
      const v = sc.vectorscope.data; let mx = 1; for (let i = 0; i < v.length; i++) if (v[i] > mx) mx = v[i];
      const im = ctx.createImageData(s, s), dd = im.data;
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const c = v[((y * 256 / s) | 0) * 256 + ((x * 256 / s) | 0)]; if (!c) continue; const p = (y * s + x) * 4; dd[p] = 120; dd[p + 1] = 255; dd[p + 2] = 160; dd[p + 3] = Math.min(255, Math.round(Math.sqrt(c / mx) * 420)); }
      const cv = (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(s, s) : Object.assign(document.createElement('canvas'), { width: s, height: s })); cv.getContext('2d').putImageData(im, 0, 0); ctx.drawImage(cv, ox, oy);
      return;
    }
    fail('Scope desconhecido: ' + kind);
  }

  /* ================= movimento: rastreamento e estabilização ================= */
  /** Cinza (Float32Array luma) reduzido por `scale` (1 = tamanho original). Devolve {w, h, d}. */
  function gray(img, scale) {
    chk(img); const k = Math.max(1, Math.round(1 / (scale || 1))), w = Math.floor(img.width / k), h = Math.floor(img.height / k), out = new Float32Array(w * h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const p = ((y * k + j) * img.width + x * k + i) * 4; s += 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]; } out[y * w + x] = s / (k * k); }
    return { w, h, d: out, k };
  }
  /** Acha onde o ponto {x,y} de `a` foi parar em `b` (casamento de bloco, SAD com refinamento sub-pixel). Devolve {x, y, score} (score 0..1, 1 = igual). */
  function trackPoint(a, b, pt, o) {
    o = Object.assign({ block: 12, search: 20 }, o); const R = o.block, S = o.search, x0 = Math.round(pt.x), y0 = Math.round(pt.y);
    if (x0 - R < 0 || y0 - R < 0 || x0 + R >= a.w || y0 + R >= a.h) return { x: pt.x, y: pt.y, score: 0 };
    let best = Infinity, bx = 0, by = 0; const area = (2 * R + 1) * (2 * R + 1), cost = new Map();
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      const cx = x0 + dx, cy = y0 + dy; if (cx - R < 0 || cy - R < 0 || cx + R >= b.w || cy + R >= b.h) continue;
      let sad = 0;
      for (let j = -R; j <= R && sad < best; j++) { const ra = (y0 + j) * a.w + x0, rb = (cy + j) * b.w + cx; for (let i = -R; i <= R; i++) sad += Math.abs(a.d[ra + i] - b.d[rb + i]); }
      cost.set(dx + ',' + dy, sad); if (sad < best) { best = sad; bx = dx; by = dy; }
    }
    if (best === Infinity) return { x: pt.x, y: pt.y, score: 0 };
    const sub = (m, c, p) => { const d = m - 2 * c + p; return d > 0 ? 0.5 * (m - p) / d : 0; };
    const cx_ = cost.get((bx - 1) + ',' + by), px_ = cost.get((bx + 1) + ',' + by), cy_ = cost.get(bx + ',' + (by - 1)), py_ = cost.get(bx + ',' + (by + 1));
    return { x: x0 + bx + (cx_ != null && px_ != null ? sub(cx_, best, px_) : 0), y: y0 + by + (cy_ != null && py_ != null ? sub(cy_, best, py_) : 0), score: clamp(1 - best / area / 64, 0, 1) };
  }
  /** Matriz 3x3 (array de 9) que leva os 4 pontos src → dst ([{x,y}×4]). */
  function homography(src, dst) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) { const { x, y } = src[i], u = dst[i].x, v = dst[i].y; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v); }
    for (let c = 0; c < 8; c++) {
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) fail('Pontos alinhados: não dá para calcular a perspectiva.');
      [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
      for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; }
    }
    const h = B.map((v, i) => v / A[i][i]); h.push(1); return h;
  }
  function applyH(h, x, y) { const w = h[6] * x + h[7] * y + h[8]; return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w }; }
  /** Rastreamento planar: segue os 4 cantos e devolve {quad, H, score}. */
  function trackPlanar(a, b, quad, o) {
    const nq = quad.map(p => trackPoint(a, b, p, o)), H = homography(quad, nq);
    return { quad: nq.map(p => ({ x: p.x, y: p.y })), H, score: Math.min.apply(null, nq.map(p => p.score)) };
  }
  /** Movimento global entre dois quadros (cinza): {dx, dy} por mediana de uma grade de blocos. */
  function estimateMotion(a, b, o) {
    o = Object.assign({ grid: 4, block: 10, search: 14 }, o); const dxs = [], dys = [];
    for (let gy = 1; gy <= o.grid; gy++) for (let gx = 1; gx <= o.grid; gx++) {
      const p = { x: a.w * gx / (o.grid + 1), y: a.h * gy / (o.grid + 1) }, r = trackPoint(a, b, p, o);
      if (r.score > 0.2) { dxs.push(r.x - p.x); dys.push(r.y - p.y); }
    }
    const med = v => { if (!v.length) return 0; v.sort((x, y) => x - y); return v[v.length >> 1]; };
    return { dx: med(dxs), dy: med(dys), n: dxs.length };
  }
  /** Dado o caminho acumulado da câmera [{x,y}], devolve a correção por quadro (suavização por média móvel de raio `radius` quadros). */
  function smoothPath(path, radius) {
    const r = radius == null ? 15 : radius;
    return path.map((p, i) => { let sx = 0, sy = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(path.length - 1, i + r); k++) { sx += path[k].x; sy += path[k].y; c++; } return { x: sx / c - p.x, y: sy / c - p.y }; });
  }

  const api = { chromaKey, grade, curveTable, parseCube, applyLUT, invert, vignette, blur, sharpen, pixelate, grain, scopes, drawScope, gray, trackPoint, trackPlanar, homography, applyH, estimateMotion, smoothPath, rgb2hsl, hsl2rgb };
  if (R4 && R4.module) R4.module('gfx', api, {
    title: 'R4.gfx', group: 'Mídia',
    description: 'Processamento de quadros sem bibliotecas: chave de croma com spill, correção de cor (lift/gamma/gain, curvas, HSL, LUT .cube), efeitos, scopes (forma de onda, parada RGB, vectorscópio, histograma), rastreamento de ponto e planar e estabilização.',
    props: [
      { name: 'chromaKey(img, {color, tolerance, softness, spill})', type: 'img', desc: 'Torna transparente a cor da chave e tira o reflexo (spill).' },
      { name: 'grade(img, {lift, gamma, gain, exposure, contrast, saturation, temperature, curves, hsl, lut})', type: 'img', desc: 'Correção primária e secundária; parseCube(texto) lê LUTs .cube.' },
      { name: 'scopes(img) / drawScope(ctx, tipo, dados, w, h)', type: 'medição', desc: 'histogram, waveform, parade e vectorscope.' },
      { name: 'trackPoint / trackPlanar / estimateMotion / smoothPath', type: 'movimento', desc: 'Casamento de blocos para rastrear pontos, superfícies planas e estabilizar.' }
    ]
  });
  if (R4) R4.gfx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window.R4 : undefined);
