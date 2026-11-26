/**
 * ============================================
 * libr4 / image.js  —  R4 dev
 * ============================================
 * R4.image: conversão e edição de imagens sem bibliotecas.
 *   decode(arquivo)                      → ImageBitmap (PNG, JPEG, WebP, GIF, BMP, AVIF... o que o navegador abrir)
 *   encode(img, formato, {quality})      → Promise<Blob>: png | jpeg | webp (pelo canvas), bmp | ico | gif | pdf (codificadores NOSSOS)
 *   resize / crop / rotate / flip / filter / grayscale / watermark → devolvem um canvas novo (entrada não é alterada)
 *   gif(frames, {delay, loop})           → GIF animado (quantização median-cut + LZW próprios)
 *   pdf([imagens], {page})               → PDF com uma imagem por página (JPEG embutido)
 *   info(arquivo)                        → { format, width, height, bytes }
 * Arquivos são dados não confiáveis: limite de tamanho e de pixels.
 * ============================================
 */
(function (R4) {
  'use strict';
  const D = R4.demux, C = R4.codec;
  const MAX_BYTES = 100 * 1024 * 1024, MAX_PIXELS = 64e6;
  const fail = (m, code) => { const e = new Error(m); if (code) e.code = code; throw e; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const canvas = (w, h) => {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w * h > MAX_PIXELS) fail('Imagem grande demais (máximo ' + Math.round(MAX_PIXELS / 1e6) + ' megapixels).');
    return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  };
  const wh = s => [s.width || s.naturalWidth || s.displayWidth, s.height || s.naturalHeight || s.displayHeight];
  const blobOf = (cv, type, q) => (cv.convertToBlob ? cv.convertToBlob({ type, quality: q }) : new Promise((ok, no) => cv.toBlob(b => (b ? ok(b) : no(new Error('encode'))), type, q)));

  /** Qualquer entrada → fonte desenhável. */
  async function decode(src) {
    if (src && typeof src === 'object' && (src.width || src.naturalWidth) && !(typeof Blob !== 'undefined' && src instanceof Blob)) return src;
    let blob = src;
    if (src instanceof Uint8Array || src instanceof ArrayBuffer) blob = new Blob([src]);
    if (!(typeof Blob !== 'undefined' && blob instanceof Blob)) fail('Entrada inválida: use File, Blob, bytes, canvas ou ImageBitmap.');
    if (blob.size > MAX_BYTES) fail('Arquivo grande demais (máximo 100 MB).');
    if (typeof createImageBitmap !== 'function') fail('Este navegador não decodifica imagens.', 'unsupported');
    try { return await createImageBitmap(blob); } catch (e) { return fail('Não foi possível abrir a imagem (formato inválido ou não suportado).', 'decode'); }
  }
  async function info(src) {
    const blob = src instanceof Blob ? src : new Blob([src]), head = new Uint8Array(await blob.slice(0, 16).arrayBuffer()), im = await decode(blob);
    const r = { format: D.sniff(head) || 'desconhecido', width: im.width, height: im.height, bytes: blob.size }; if (im.close) im.close(); return r;
  }
  const toCanvas = async (src, w, h) => {
    const im = await decode(src), [iw, ih] = wh(im), cv = canvas(w || iw, h || ih); cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    if (im !== src && im.close) im.close(); return cv;
  };

  /* ---------- edição (devolvem canvas) ---------- */
  /** resize(img, {width, height, fit:'contain'|'cover'|'fill', background}) – sem width/height um deles mantém a proporção. */
  async function resize(src, o) {
    o = o || {}; const im = await decode(src), [iw, ih] = wh(im); let w = o.width, h = o.height;
    if (!w && !h) fail('Informe width e/ou height.');
    if (!w) w = ih ? iw * h / ih : h; if (!h) h = iw ? ih * w / iw : w;
    const cv = canvas(w, h), cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high';
    const fit = o.fit || 'fill';
    if (o.background) { cx.fillStyle = o.background; cx.fillRect(0, 0, cv.width, cv.height); }
    if (fit === 'fill') cx.drawImage(im, 0, 0, cv.width, cv.height);
    else {
      const k = fit === 'cover' ? Math.max(cv.width / iw, cv.height / ih) : Math.min(cv.width / iw, cv.height / ih), dw = iw * k, dh = ih * k;
      cx.drawImage(im, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    }
    if (im !== src && im.close) im.close(); return cv;
  }
  async function crop(src, x, y, w, h) {
    const im = await decode(src), cv = canvas(w, h); cv.getContext('2d').drawImage(im, x, y, w, h, 0, 0, cv.width, cv.height); if (im !== src && im.close) im.close(); return cv;
  }
  /** rotate(img, graus) – múltiplos de 90 sem perda; outros ângulos ampliam o canvas. */
  async function rotate(src, deg) {
    const im = await decode(src), [iw, ih] = wh(im), r = deg * Math.PI / 180, s = Math.abs(Math.sin(r)), c = Math.abs(Math.cos(r)), w = iw * c + ih * s, h = iw * s + ih * c;
    const cv = canvas(w, h), cx = cv.getContext('2d'); cx.translate(cv.width / 2, cv.height / 2); cx.rotate(r); cx.drawImage(im, -iw / 2, -ih / 2); if (im !== src && im.close) im.close(); return cv;
  }
  async function flip(src, horizontal) {
    const im = await decode(src), [iw, ih] = wh(im), cv = canvas(iw, ih), cx = cv.getContext('2d');
    if (horizontal === false) { cx.translate(0, ih); cx.scale(1, -1); } else { cx.translate(iw, 0); cx.scale(-1, 1); }
    cx.drawImage(im, 0, 0); if (im !== src && im.close) im.close(); return cv;
  }
  /** filter(img, 'brightness(1.2) contrast(1.1) blur(2px)') – sintaxe de filtros CSS. */
  async function filter(src, css) {
    const im = await decode(src), [iw, ih] = wh(im), cv = canvas(iw, ih), cx = cv.getContext('2d'); cx.filter = String(css); cx.drawImage(im, 0, 0); if (im !== src && im.close) im.close(); return cv;
  }
  const grayscale = src => filter(src, 'grayscale(1)');
  /** watermark(img, texto|imagem, {x, y, size, color, alpha, position}) */
  async function watermark(src, mark, o) {
    o = o || {}; const cv = await toCanvas(src), cx = cv.getContext('2d'), pad = Math.round(cv.width * 0.02);
    cx.globalAlpha = o.alpha == null ? 0.6 : o.alpha;
    if (typeof mark === 'string') {
      const size = o.size || Math.max(12, Math.round(cv.width / 24)); cx.font = '600 ' + size + 'px sans-serif'; cx.fillStyle = o.color || '#fff'; cx.textBaseline = 'bottom';
      const tw = cx.measureText(mark).width, pos = o.position || 'bottom-right';
      const x = o.x != null ? o.x : (/left/.test(pos) ? pad : /center/.test(pos) ? (cv.width - tw) / 2 : cv.width - tw - pad), y = o.y != null ? o.y : (/top/.test(pos) ? size + pad : cv.height - pad);
      cx.shadowColor = 'rgba(0,0,0,.5)'; cx.shadowBlur = size / 6; cx.fillText(mark, x, y);
    } else {
      const m = await decode(mark), [mw, mh] = wh(m), k = o.size ? o.size / mw : Math.min(1, cv.width / 4 / mw), w = mw * k, h = mh * k, pos = o.position || 'bottom-right';
      cx.drawImage(m, o.x != null ? o.x : (/left/.test(pos) ? pad : cv.width - w - pad), o.y != null ? o.y : (/top/.test(pos) ? pad : cv.height - h - pad), w, h); if (m !== mark && m.close) m.close();
    }
    return cv;
  }

  /* ---------- codificadores próprios ---------- */
  const pixels = async src => { const cv = await toCanvas(src); return { w: cv.width, h: cv.height, data: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, cv }; };
  const u16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = v >> 8 & 255; }, u32 = (a, o, v) => { a[o] = v & 255; a[o + 1] = v >> 8 & 255; a[o + 2] = v >> 16 & 255; a[o + 3] = v >>> 24; };

  /** BMP 24 bits (alpha composto sobre `background`, branco por padrão). */
  async function encodeBMP(src, o) {
    const { w, h, data } = await pixels(src), bg = (o && o.background) || [255, 255, 255], row = (w * 3 + 3) & ~3, size = 54 + row * h, out = new Uint8Array(size);
    out[0] = 66; out[1] = 77; u32(out, 2, size); u32(out, 10, 54); u32(out, 14, 40); u32(out, 18, w); u32(out, 22, h); u16(out, 26, 1); u16(out, 28, 24); u32(out, 34, row * h); u32(out, 38, 2835); u32(out, 42, 2835);
    for (let y = 0; y < h; y++) {
      let p = 54 + (h - 1 - y) * row;
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, a = data[i + 3] / 255; out[p++] = data[i + 2] * a + bg[2] * (1 - a); out[p++] = data[i + 1] * a + bg[1] * (1 - a); out[p++] = data[i] * a + bg[0] * (1 - a); }
    }
    return new Blob([out], { type: 'image/bmp' });
  }
  /** ICO com várias resoluções (PNG embutido). sizes padrão: 16, 32, 48, 64, 128, 256. */
  async function encodeICO(src, o) {
    const sizes = ((o && o.sizes) || [16, 32, 48, 64, 128, 256]).filter(n => n >= 1 && n <= 256), im = await decode(src), [iw, ih] = wh(im), pngs = [];
    for (const n of sizes) { const k = Math.min(n / iw, n / ih), cv = canvas(n, n), cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(im, (n - iw * k) / 2, (n - ih * k) / 2, iw * k, ih * k); pngs.push(new Uint8Array(await (await blobOf(cv, 'image/png')).arrayBuffer())); }
    if (im !== src && im.close) im.close();
    const head = 6 + 16 * sizes.length, total = head + pngs.reduce((s, p) => s + p.length, 0), out = new Uint8Array(total); u16(out, 2, 1); u16(out, 4, sizes.length);
    let off = head;
    sizes.forEach((n, i) => { const e = 6 + i * 16; out[e] = n === 256 ? 0 : n; out[e + 1] = n === 256 ? 0 : n; u16(out, e + 4, 1); u16(out, e + 6, 32); u32(out, e + 8, pngs[i].length); u32(out, e + 12, off); out.set(pngs[i], off); off += pngs[i].length; });
    return new Blob([out], { type: 'image/x-icon' });
  }

  // GIF: quantização median-cut + LZW
  function quantize(data, n) {
    const px = []; for (let i = 0; i < data.length; i += 4) px.push(i);
    const cap = 40000, samp = px.length > cap ? px.filter((_, i) => i % Math.ceil(px.length / cap) === 0) : px;
    let boxes = [samp];
    const range = b => { let mn = [255, 255, 255], mx = [0, 0, 0]; for (const i of b) for (let c = 0; c < 3; c++) { const v = data[i + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; } const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; return { r, c: r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2 }; };
    while (boxes.length < n) {
      let bi = -1, bs = 0, bc = 0;
      boxes.forEach((b, i) => { if (b.length < 2) return; const g = range(b), s = Math.max(...g.r) * Math.sqrt(b.length); if (s > bs) { bs = s; bi = i; bc = g.c; } });
      if (bi < 0) break;
      const b = boxes[bi].slice().sort((x, y) => data[x + bc] - data[y + bc]), m = b.length >> 1; boxes.splice(bi, 1, b.slice(0, m), b.slice(m));
    }
    return boxes.map(b => { let r = 0, g = 0, bl = 0; for (const i of b) { r += data[i]; g += data[i + 1]; bl += data[i + 2]; } const k = b.length || 1; return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)]; });
  }
  function lzw(idx, minBits) {
    const clear = 1 << minBits, eoi = clear + 1, out = []; let bits = minBits + 1, next = eoi + 1, dict = new Map(), cur = 0, nb = 0, buf = [];
    const put = c => { cur |= c << nb; nb += bits; while (nb >= 8) { buf.push(cur & 255); cur >>>= 8; nb -= 8; } };
    put(clear); let pre = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const k = idx[i], key = pre * 4096 + k, v = dict.get(key);
      if (v !== undefined) pre = v;
      else {
        put(pre);
        if (next < 4096) { dict.set(key, next++); if (next > (1 << bits) && bits < 12) bits++; }
        else { put(clear); dict = new Map(); bits = minBits + 1; next = eoi + 1; }
        pre = k;
      }
    }
    put(pre); put(eoi); if (nb > 0) buf.push(cur & 255);
    for (let i = 0; i < buf.length; i += 255) { const n = Math.min(255, buf.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(buf[i + j]); }
    out.push(0); return out;
  }
  /** GIF (animado se houver vários quadros). frames: imagens/canvases; delay em ms; loop 0 = infinito. */
  async function gif(frames, o) {
    o = o || {}; frames = [].concat(frames); if (!frames.length) fail('Informe ao menos um quadro.'); if (frames.length > 2000) fail('Quadros demais (máximo 2000).');
    const first = await pixels(frames[0]), w = first.w, h = first.h, out = [71, 73, 70, 56, 57, 97, w & 255, w >> 8, h & 255, h >> 8, 0x70, 0, 0];
    if (frames.length > 1) out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map(c => c.charCodeAt(0)), 3, 1, (o.loop || 0) & 255, (o.loop || 0) >> 8, 0);
    const delays = [].concat(o.delay == null ? 100 : o.delay);
    for (let f = 0; f < frames.length; f++) {
      const fr = f === 0 ? first : await pixels(await resize(frames[f], { width: w, height: h, fit: 'contain' })), d = fr.data;
      const pal = quantize(d, 255), real = pal.length; while (pal.length < 256) pal.push([0, 0, 0]); const tr = 255, size = 256, cache = new Map(), idx = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i + 3] < 128) { idx[p] = tr; continue; }
        const key = (d[i] >> 2) << 12 | (d[i + 1] >> 2) << 6 | d[i + 2] >> 2; let v = cache.get(key);
        if (v === undefined) { let best = 1e9; v = 0; for (let k = 0; k < real; k++) { const q = pal[k], e = (q[0] - d[i]) ** 2 + (q[1] - d[i + 1]) ** 2 + (q[2] - d[i + 2]) ** 2; if (e < best) { best = e; v = k; } } cache.set(key, v); }
        idx[p] = v;
      }
      const delay = Math.round((delays[Math.min(f, delays.length - 1)] || 100) / 10);
      out.push(0x21, 0xf9, 4, 0x09, delay & 255, delay >> 8, tr, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0x87);
      for (let i = 0; i < size; i++) out.push(...(pal[i] || [0, 0, 0]));
      out.push(8, ...lzw(idx, 8));
      if (f === 0 && frames.length === 1) { /* único quadro */ }
    }
    out.push(0x3b);
    return new Blob([Uint8Array.from(out)], { type: 'image/gif' });
  }

  /** PDF com uma imagem por página (JPEG embutido). page: 'fit' (tamanho da imagem) | 'a4'. */
  async function pdf(list, o) {
    o = o || {}; list = [].concat(list); if (!list.length) fail('Informe ao menos uma imagem.'); if (list.length > 500) fail('Páginas demais (máximo 500).');
    const enc = new TextEncoder(), chunks = [], offs = []; let len = 0;
    const add = b => { const u = typeof b === 'string' ? enc.encode(b) : b; chunks.push(u); len += u.length; };
    const obj = (n, body) => { offs[n] = len; add(n + ' 0 obj\n'); add(body); add('\nendobj\n'); };
    add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const N = list.length, pages = []; let next = 3;
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = [];
    for (let i = 0; i < N; i++) {
      const im = await decode(list[i]), [iw, ih] = wh(im), cv = canvas(iw, ih), cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, iw, ih); cx.drawImage(im, 0, 0); if (im !== list[i] && im.close) im.close();
      const jpg = new Uint8Array(await (await blobOf(cv, 'image/jpeg', o.quality || 0.9)).arrayBuffer());
      let pw = iw * 0.75, ph = ih * 0.75, dx = 0, dy = 0, dw = pw, dh = ph;
      if (o.page === 'a4') { pw = 595.28; ph = 841.89; const k = Math.min((pw - 40) / iw, (ph - 40) / ih); dw = iw * k; dh = ih * k; dx = (pw - dw) / 2; dy = (ph - dh) / 2; }
      const pg = next++, ct = next++, ig = next++; kids.push(pg + ' 0 R');
      pages.push({ pg, ct, ig, pw, ph, dx, dy, dw, dh, iw, ih, jpg });
    }
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + N + ' >>');
    for (const p of pages) {
      const f = n => (Math.round(n * 100) / 100).toString();
      obj(p.pg, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f(p.pw) + ' ' + f(p.ph) + '] /Resources << /XObject << /Im0 ' + p.ig + ' 0 R >> >> /Contents ' + p.ct + ' 0 R >>');
      const cs = 'q ' + f(p.dw) + ' 0 0 ' + f(p.dh) + ' ' + f(p.dx) + ' ' + f(p.dy) + ' cm /Im0 Do Q';
      obj(p.ct, '<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream');
      offs[p.ig] = len; add(p.ig + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + p.iw + ' /Height ' + p.ih + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpg.length + ' >>\nstream\n'); add(p.jpg); add('\nendstream\nendobj\n');
    }
    const total = next, xr = len; let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let n = 1; n < total; n++) x += String(offs[n]).padStart(10, '0') + ' 00000 n \n';
    add(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xr + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  const NATIVE = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };
  /** encode(img, 'png'|'jpeg'|'webp'|'avif'|'bmp'|'ico'|'gif'|'pdf', {quality, background, sizes}) → Blob */
  async function encode(src, format, o) {
    format = String(format || 'png').toLowerCase().replace(/^\./, ''); o = o || {};
    if (format === 'bmp') return encodeBMP(src, o); if (format === 'ico') return encodeICO(src, o); if (format === 'gif') return gif(src, o); if (format === 'pdf') return pdf(src, o);
    const mime = NATIVE[format]; if (!mime) fail('Formato de imagem desconhecido: ' + format, 'format');
    const cv = await toCanvas(src);
    if (mime === 'image/jpeg' && o.background !== false) { const c2 = canvas(cv.width, cv.height), x = c2.getContext('2d'); x.fillStyle = o.background || '#fff'; x.fillRect(0, 0, c2.width, c2.height); x.drawImage(cv, 0, 0); return blobOf(c2, mime, o.quality == null ? 0.9 : o.quality); }
    const b = await blobOf(cv, mime, o.quality == null ? 0.92 : o.quality);
    if (b.type !== mime) fail('Este navegador não codifica ' + format.toUpperCase() + '.', 'unsupported');
    return b;
  }
  /** Formatos de imagem de saída disponíveis agora. */
  async function formats() {
    const out = ['png', 'jpeg', 'bmp', 'ico', 'gif', 'pdf'], cv = canvas(16, 16); cv.getContext('2d').fillRect(0, 0, 8, 8);
    for (const f of ['webp', 'avif']) { try { if ((await blobOf(cv, NATIVE[f])).type === NATIVE[f]) out.splice(2, 0, f); } catch (e) { /* sem suporte */ } }
    return out;
  }

  const api = { decode, info, resize, crop, rotate, flip, filter, grayscale, watermark, encode, formats, gif, pdf, toCanvas };
  R4.module('image', api, {
    title: 'R4.image', group: 'Mídia',
    description: 'Conversão e edição de imagens sem bibliotecas: PNG, JPEG, WebP, AVIF (codificadores do navegador) e BMP, ICO, GIF animado e PDF (codificadores nossos); redimensionar, cortar, girar, espelhar, filtros, marca d\'água.',
    props: [
      { name: 'encode(imagem, formato, {quality, sizes, background})', type: 'Promise<Blob>', desc: 'formato: png, jpeg, webp, avif, bmp, ico, gif, pdf.' },
      { name: 'resize(imagem, {width, height, fit:"fill|contain|cover"}) / crop(imagem,x,y,w,h) / rotate(imagem, graus) / flip(imagem) / filter(imagem, "css") / grayscale / watermark(imagem, texto|imagem, opções)', type: 'Promise<Canvas>', desc: 'A entrada não é alterada; encadeie com encode.' },
      { name: 'gif(quadros, {delay, loop}) / pdf(imagens, {page:"fit|a4", quality})', type: 'Promise<Blob>', desc: 'GIF animado e PDF de várias páginas.' },
      { name: 'decode(arquivo) / info(arquivo) / formats()', type: 'Promise', desc: 'Abrir, inspecionar e listar formatos de saída.' }
    ]
  });
  R4.image = R4.modules.image.api;
})(window.R4);
