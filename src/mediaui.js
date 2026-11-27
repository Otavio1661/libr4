/**
 * ============================================
 * libr4 / mediaui.js  —  R4 dev
 * ============================================
 * Componentes de mídia (tags <r4-...>), todos sobre os módulos R4.audio / R4.video / R4.music / R4.convert / R4.image:
 *   <r4-audioeditor>  editor de áudio: forma de onda, seleção, tocar, cortar, aparar, fade, normalizar, inverter, desfazer, exportar
 *   <r4-videoeditor>  editor de vídeo: pré-visualização, trecho, tamanho, giro, velocidade, filtro, mudo, exportar MP4/WebM
 *   <r4-converter>    conversor de arquivos (arrastar/soltar, escolhe o formato, baixa o resultado)
 *   <r4-piano>        teclado de piano (mouse, toque e teclado do computador)
 *   <r4-recorder>     gravador de microfone, tela ou câmera (pausar, medidor de nível, lista de gravações)
 * JS: R4.audioeditor('#alvo', { src }), R4.videoeditor(...), R4.converter(...), R4.piano(...)
 * Arquivos do usuário são dados não confiáveis: nomes só entram como texto, tipos conferidos pelo conteúdo, limites de tamanho.
 * ============================================
 */
(function (R4) {
  'use strict';
  const { el, tx } = R4.util, T = R4.util.T;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmtT = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
  const TT = (p, k, d, a) => T('r4.' + p + '.' + k, a, d);
  const shown = n => (R4.sanitize ? R4.sanitize.filename(n) : String(n == null ? '' : n));
  const btn = (cls, ns, key, fb, primary) => { const b = el('button', { type: 'button', class: 'r4-btn r4-md-btn ' + (primary ? 'r4-btn-primary ' : '') + cls }); tx(b, 'r4.' + ns + '.' + key, fb); return b; };
  const lbl = (ns, key, fb) => tx(el('span', { class: 'r4-md-lbl' }), 'r4.' + ns + '.' + key, fb);
  const sel = (items, cls) => { const s = el('select', { class: 'r4-md-sel ' + (cls || '') }); items.forEach(i => { const o = el('option', { value: String(i[0]), text: i[1] }); s.append(o); }); return s; };
  const picker = (accept, multiple, onFiles) => {
    const inp = el('input', { type: 'file', accept, hidden: true, tabindex: '-1' }); if (multiple) inp.multiple = true;
    inp.addEventListener('change', () => { const f = [...inp.files]; inp.value = ''; if (f.length) onFiles(f); });
    return inp;
  };
  function dropZone(node, onFiles) {
    const over = e => { e.preventDefault(); node.classList.add('r4-md-over'); }, out = () => node.classList.remove('r4-md-over');
    node.addEventListener('dragover', over); node.addEventListener('dragenter', over); node.addEventListener('dragleave', out);
    node.addEventListener('drop', e => { e.preventDefault(); out(); const f = [...(e.dataTransfer ? e.dataTransfer.files : [])]; if (f.length) onFiles(f); });
  }
  const need = (mod, label) => { if (!R4[mod]) throw new Error('Módulo R4.' + mod + ' não carregado (' + label + ').'); };
  const MB = 1048576;
  /** Aceita o resultado de outro componente ({ blob, name }) no lugar do arquivo: permite ligar tags por r4-on. */
  const asFile = s => { if (s && !(s instanceof Blob) && s.blob instanceof Blob) { const b = s.blob; if (s.name && !b.name) { try { return new File([b], s.name, { type: b.type }); } catch (e) { return b; } } return b; } return s; };

  /* ================= <r4-audioeditor> ================= */
  R4.define('audioeditor', {
    config: { src: null, height: 160, format: 'wav', maxSize: 200 * MB, name: 'audio' },
    build() {
      need('audio', 'audioeditor'); const N = 'audioeditor';
      this._a = null; this._hist = []; this._redo = []; this._sel = null; this._play = null; this._raf = 0; this._tok = 0; this._offs = [];
      this.cv = el('canvas', { class: 'r4-md-cv', 'aria-hidden': 'true' });
      this.stage = el('div', { class: 'r4-md-stage', tabindex: '0', role: 'application', style: { height: (+this.height || 160) + 'px' } }, [this.cv]);
      tx(this.stage, 'r4.audioeditor.area', 'Forma de onda: arraste para selecionar um trecho; espaço toca; setas movem a seleção', 'aria-label');
      this.emptyEl = el('div', { class: 'r4-md-empty' }); this.choose = btn('', N, 'choose', 'Escolher áudio', true); this.emptyEl.append(tx(el('span'), 'r4.audioeditor.empty', 'Nenhum áudio carregado. Arraste um arquivo ou'), this.choose);
      this.stage.append(this.emptyEl);
      this.fileIn = picker('audio/*,video/*,.mid,.midi', false, f => this.load(f[0]).catch(() => {}));
      this.info = el('div', { class: 'r4-md-info', 'aria-live': 'polite' });
      const B = (k, fb, f) => { const b = btn('', N, k, fb); b.addEventListener('click', f); return b; };
      this.bPlay = btn('', N, 'play', 'Tocar', true); this.bStop = B('stop', 'Parar', () => this.stop());
      this.bPlay.addEventListener('click', () => this.toggle());
      this.tools = {
        trim: B('trim', 'Manter seleção', () => this._edit(a => R4.audio.trim(a, this._sel.from, this._sel.to), true)),
        cut: B('cut', 'Remover seleção', () => this._edit(a => R4.audio.cut(a, this._sel.from, this._sel.to), true)),
        fadeIn: B('fadeIn', 'Fade-in', () => this._edit(a => R4.audio.fade(a, this._len() > 3 ? 1 : this._len() / 3, 0))),
        fadeOut: B('fadeOut', 'Fade-out', () => this._edit(a => R4.audio.fade(a, 0, this._len() > 3 ? 1 : this._len() / 3))),
        norm: B('normalize', 'Normalizar', () => this._edit(a => R4.audio.normalize(a))),
        rev: B('reverse', 'Inverter', () => this._edit(a => R4.audio.reverse(a))),
        sil: B('silence', 'Tirar silêncios', () => this._edit(a => R4.audio.removeSilence(a))),
        undo: B('undo', 'Desfazer', () => this.undo()), redo: B('redo', 'Refazer', () => this.redo())
      };
      this.gainR = el('input', { type: 'range', class: 'r4-md-range', min: '-24', max: '24', step: '1', value: '0' }); tx(this.gainR, 'r4.audioeditor.gain', 'Ganho (dB)', 'aria-label');
      this.gainO = el('output', { class: 'r4-md-out', text: '0 dB' }); this.gainB = B('apply', 'Aplicar ganho', () => { const g = +this.gainR.value; this.gainR.value = '0'; this.gainO.textContent = '0 dB'; if (g) this._edit(a => R4.audio.gain(a, g)); });
      this.gainR.addEventListener('input', () => { this.gainO.textContent = this.gainR.value + ' dB'; });
      this.fmt = sel([['wav', 'WAV'], ['flac', 'FLAC'], ['aiff', 'AIFF'], ['opus', 'Opus'], ['ogg', 'OGG']], 'r4-md-fmt'); this.fmt.value = this.format; tx(this.fmt, 'r4.audioeditor.format', 'Formato de saída', 'aria-label');
      this.bExport = B('export', 'Baixar', () => this.download());
      this.msgEl = el('div', { class: 'r4-md-msg', role: 'alert', hidden: true });
      this._all = [this.bPlay, this.bStop, ...Object.values(this.tools), this.gainR, this.gainB, this.fmt, this.bExport];
      this._ctl(false);
      R4.audio.formats().then(ok => { [...this.fmt.options].forEach(o => { if (!ok.includes(o.value)) o.disabled = true; }); }).catch(() => {});
      return el('div', { class: 'r4-md r4-md-audio' }, [this.stage, this.info,
        el('div', { class: 'r4-md-bar' }, [this.bPlay, this.bStop, this.tools.trim, this.tools.cut, this.tools.undo, this.tools.redo]),
        el('div', { class: 'r4-md-bar' }, [this.tools.fadeIn, this.tools.fadeOut, this.tools.norm, this.tools.rev, this.tools.sil]),
        el('div', { class: 'r4-md-bar' }, [lbl(N, 'gain', 'Ganho (dB)'), this.gainR, this.gainO, this.gainB]),
        el('div', { class: 'r4-md-bar' }, [lbl(N, 'format', 'Formato de saída'), this.fmt, this.bExport]), this.msgEl, this.fileIn]);
    },
    afterRender() {
      const on = (t, e, f, o) => { t.addEventListener(e, f, o); this._offs.push(() => t.removeEventListener(e, f, o)); };
      on(this.choose, 'click', () => this.fileIn.click()); dropZone(this.stage, f => this.load(f[0]).catch(() => {}));
      const xOf = ev => { const r = this.stage.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * this._dur(); };
      let anchor = null;
      on(this.stage, 'pointerdown', ev => { if (!this._a || ev.button > 0) return; this.stage.focus({ preventScroll: true }); try { this.stage.setPointerCapture(ev.pointerId); } catch (e) { /* ignora */ } anchor = xOf(ev); this._sel = null; this._draw(); });
      on(this.stage, 'pointermove', ev => { if (anchor == null) return; const t = xOf(ev); this._sel = Math.abs(t - anchor) > 0.01 ? { from: Math.min(anchor, t), to: Math.max(anchor, t) } : null; this._ctl(true); this._draw(); });
      on(this.stage, 'pointerup', ev => { if (anchor == null) return; const t = xOf(ev); if (!this._sel) { this._cursor = t; this._draw(); } anchor = null; this._ctl(true); });
      on(this.stage, 'keydown', ev => {
        if (!this._a) return;
        if (ev.key === ' ') { ev.preventDefault(); this.toggle(); }
        else if (ev.key === 'Escape') { this._sel = null; this._ctl(true); this._draw(); }
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); const d = (ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 0.01 : 0.1), s = this._sel || { from: this._cursor || 0, to: this._cursor || 0 }; if (this._sel) this._sel = { from: clamp(s.from + d, 0, this._dur()), to: clamp(s.to + d, 0, this._dur()) }; else this._cursor = clamp(s.from + d, 0, this._dur()); this._draw(); }
        else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? this.redo() : this.undo(); }
      });
      if (window.ResizeObserver) { const ro = new ResizeObserver(() => this._draw()); ro.observe(this.stage); this._offs.push(() => ro.disconnect()); }
      if (this.src) this.load(this.src).catch(() => {});
    },
    _dur() { return this._a ? this._a.channels[0].length / this._a.sampleRate : 0; },
    _len() { return this._sel ? this._sel.to - this._sel.from : this._dur(); },
    _ctl(ready) {
      const has = !!this._a, selOn = !!this._sel;
      this._all.forEach(c => { c.disabled = !has; });
      if (this.tools) { this.tools.trim.disabled = !selOn; this.tools.cut.disabled = !selOn; this.tools.undo.disabled = !this._hist.length; this.tools.redo.disabled = !this._redo.length; }
      this.bStop.disabled = !this._play;
    },
    _msg(m) { this.msgEl.textContent = m || ''; this.msgEl.hidden = !m; },
    _setAudio(a, keep) {
      this.stop(); this._a = a; if (!keep) { this._sel = null; this._cursor = 0; } this._peaks = null; this.emptyEl.hidden = true;
      this.info.textContent = fmtT(this._dur()) + ' · ' + a.sampleRate + ' Hz · ' + a.channels.length + (a.channels.length === 1 ? ' canal' : ' canais');
      this._ctl(true); this._draw();
    },
    _edit(fn, useSel) {
      if (!this._a) return this; if (useSel && !this._sel) return this;
      this._msg('');
      try {
        const a = this._a, hasSel = this._sel && !useSel, from = hasSel ? this._sel.from : 0, to = hasSel ? this._sel.to : this._dur();
        let r;
        if (hasSel) { const head = R4.audio.trim(a, 0, from), mid = fn(R4.audio.trim(a, from, to)), tail = R4.audio.trim(a, to, this._dur()); r = R4.audio.concat([head, mid, tail].filter(x => x.channels[0].length)); }
        else r = fn(a);
        this._hist.push(a); if (this._hist.length > 20) this._hist.shift(); this._redo.length = 0; this._setAudio(r, !useSel); this.fire('change', this, this.getInfo());
      } catch (e) { this._msg(e.message); this.fire('error', this, e.message, e.code); }
      return this;
    },
    undo() { if (!this._hist.length) return this; this._redo.push(this._a); this._setAudio(this._hist.pop(), true); this.fire('change', this, this.getInfo()); return this; },
    redo() { if (!this._redo.length) return this; this._hist.push(this._a); this._setAudio(this._redo.pop(), true); this.fire('change', this, this.getInfo()); return this; },
    async load(src) {
      src = asFile(src); const tok = ++this._tok; this._msg('');
      try {
        if (src && src.size > this.maxSize) throw new Error(TT('audioeditor', 'tooBig', 'Arquivo grande demais.'));
        let a;
        if (src && src.channels && src.sampleRate) a = src;
        else { this._name = shown(src && src.name ? String(src.name).replace(/\.[^.]*$/, '') : this.name); a = await (src && /\.midi?$/i.test(src.name || '') ? R4.convert('audio', src, 'wav').then(r => R4.audio.decode(r.blob)) : R4.audio.decode(src)); }
        if (tok !== this._tok || this._destroyed) return this;
        this._hist = []; this._redo = []; this._setAudio(a); this.fire('ready', this, this.getInfo());
      } catch (e) { if (tok === this._tok && !this._destroyed) { this._msg(e.message); this.fire('error', this, e.message, e.code); } throw e; }
      return this;
    },
    getAudio() { return this._a; }, getInfo() { return { duration: this._dur(), sampleRate: this._a ? this._a.sampleRate : 0, channels: this._a ? this._a.channels.length : 0, selection: this._sel }; }, isReady() { return !!this._a; },
    async getBlob(format, o) { if (!this._a) throw new Error(TT('audioeditor', 'noAudio', 'Nenhum áudio carregado.')); return R4.audio.encode(this._a, format || this.fmt.value, o); },
    /** Gera o arquivo no formato escolhido, guarda em .blob e dispara done(cmp, blob, info) (para r4-on). */
    async apply(format) { const f = format || this.fmt.value, b = await this.getBlob(f); this.blob = b; this.fire('done', this, b, { format: f, name: this._name || 'audio', size: b.size, type: b.type }); return b; },
    async download(format) {
      try { this._msg(''); const f = format || this.fmt.value, b = await this.getBlob(f); R4.files ? R4.files.download(b, (this._name || 'audio') + '.' + f, b.type) : null; }
      catch (e) { this._msg(e.message); this.fire('error', this, e.message, e.code); }
      return this;
    },
    toggle() { return this._play ? this.stop() : this.play(); },
    play() {
      if (!this._a || this._play) return this; const s = this._sel; let from = s ? s.from : this._cursor || 0;
      try { this._play = R4.audio.play(this._a, { from, to: s ? s.to : undefined }); } catch (e) { this._msg(e.message); return this; }
      const h = this._play; tx(this.bPlay, 'r4.audioeditor.pause', 'Parar'); this.bPlay.classList.remove('r4-btn-primary'); this._ctl(true);
      h.ended.then(() => { if (this._play === h) { this._play = null; this._reset(); } });
      const tick = () => { if (this._play !== h || this._destroyed) return; this._head = h.position(); this._draw(); this._raf = requestAnimationFrame(tick); }; tick();
      return this;
    },
    stop() { const h = this._play; if (h) { this._play = null; h.stop(); } if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } this._head = null; this._reset(); this._draw(); return this; },
    _reset() { if (this.bPlay) { tx(this.bPlay, 'r4.audioeditor.play', 'Tocar'); this.bPlay.classList.add('r4-btn-primary'); this._ctl(true); } },
    _draw() {
      const cv = this.cv, r = this.stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; this._peaks = null; }
      const cx = cv.getContext('2d'), cs = getComputedStyle(this.stage), col = n => cs.getPropertyValue(n).trim();
      cx.clearRect(0, 0, w, h); if (!this._a) return;
      if (!this._peaks) this._peaks = R4.audio.peaks(this._a, w);
      const p = this._peaks, mid = h / 2, dur = this._dur() || 1, px = t => t / dur * w;
      if (this._sel) { cx.fillStyle = col('--r4-sel') || '#dbe4ff'; cx.fillRect(px(this._sel.from), 0, Math.max(1, px(this._sel.to) - px(this._sel.from)), h); }
      cx.fillStyle = col('--r4-acc') || '#3b5bdb';
      for (let i = 0; i < w; i++) { const mn = p[i * 2], mx = p[i * 2 + 1], y1 = mid - mx * mid * 0.95, y2 = mid - mn * mid * 0.95; cx.fillRect(i, y1, 1, Math.max(1, y2 - y1)); }
      cx.fillStyle = col('--r4-mut') || '#888'; cx.fillRect(0, mid, w, 1);
      const x = this._head != null ? this._head : (!this._sel ? this._cursor : null);
      if (x != null) { cx.fillStyle = col('--r4-txt') || '#000'; cx.fillRect(Math.round(px(x)), 0, Math.max(1, Math.round(dpr)), h); }
    },
    destroy() { const was = this._destroyed; R4.Component.prototype.destroy.call(this); if (was || !this._destroyed) return this; this._tok++; this.stop(); (this._offs || []).splice(0).forEach(f => f()); this._a = null; this._hist = []; this._redo = []; return this; }
  }, {
    title: 'audioeditor', group: 'Mídia',
    description: 'Editor de áudio no navegador, sem bibliotecas: forma de onda, seleção por arraste, tocar, manter/remover trecho, fade-in/out, normalizar, ganho, inverter, tirar silêncios, desfazer/refazer (até 20 passos) e exportar em WAV, FLAC, AIFF, Opus ou OGG. Abre MP3/AAC/vídeo se o navegador souber decodificar. Teclado: espaço toca, setas movem, Esc limpa a seleção, Ctrl+Z desfaz.',
    props: [
      { name: 'src', type: 'File | Blob | áudio', default: 'null', desc: 'Arquivo a editar. Sem src, mostra "Escolher áudio" e aceita arrastar/soltar.' },
      { name: 'format / height / maxSize / name', type: 'string / px / bytes', default: "'wav' / 160 / 200 MB / 'audio'", desc: 'Formato inicial de exportação, altura da onda, limite do arquivo e nome-base do download.' },
      { name: 'load(src) / getAudio() / getBlob(formato) / download(formato)', type: 'método', desc: 'Carregar (File, Blob ou { blob, name } de outra tag: r4-on="done:#ed.load"), ler o áudio editado, gerar o arquivo e baixar.' },
      { name: 'play() / stop() / undo() / redo() / destroy()', type: 'método', desc: 'Controle. destroy() para o som e libera os listeners.' },
      { name: 'apply(formato)', type: 'Promise<Blob>', desc: 'Gera o arquivo, guarda em .blob e dispara done(cmp, blob, info): r4-on="done:#conv.load" ou r4-click="download:#id".' },
      { name: 'ready / change / done / error', type: 'evento', desc: 'ready(cmp) depois de carregar; change(cmp, info) a cada edição; done(cmp, blob, info) após apply(); error(cmp, mensagem, código).' }
    ],
    events: ['ready', 'change', 'done', 'error']
  });
  R4.registry.audioeditor.meta.playground = { html: '<r4-audioeditor{attrs}></r4-audioeditor>', cfg: {}, controls: { format: ['wav', 'flac', 'aiff', 'opus', 'ogg'], height: 160 } };
  if (R4.quickMap) R4.quickMap.audioeditor = (a, b) => (a && typeof a === 'object' && !(a instanceof Blob) && !a.channels ? a : Object.assign({ src: a }, b));

  /* ================= <r4-videoeditor> ================= */
  R4.define('videoeditor', {
    config: { src: null, format: 'mp4', maxSize: 500 * MB, height: 280, name: 'video' },
    build() {
      need('video', 'videoeditor'); const N = 'videoeditor'; const sup = R4.video.support ? R4.video.support() : { video: true }; this._offs = []; this._url = null; this._tok = 0; this._busy = null;
      this.vid = el('video', { class: 'r4-md-video', controls: true, playsinline: true, preload: 'metadata', style: { maxHeight: (+this.height || 280) + 'px' } }); this.vid.muted = false;
      tx(this.vid, 'r4.videoeditor.player', 'Pré-visualização do vídeo', 'aria-label');
      this.emptyEl = el('div', { class: 'r4-md-empty' }); this.choose = btn('', N, 'choose', 'Escolher vídeo', true); this.emptyEl.append(tx(el('span'), 'r4.videoeditor.empty', 'Nenhum vídeo carregado. Arraste um arquivo ou'), this.choose);
      this.stage = el('div', { class: 'r4-md-stage r4-md-vstage' }, [this.vid, this.emptyEl]);
      this.fileIn = picker('video/*', false, f => this.load(f[0]).catch(() => {}));
      this.info = el('div', { class: 'r4-md-info', 'aria-live': 'polite' });
      const range = (k, fb) => { const r = el('input', { type: 'range', class: 'r4-md-range', min: '0', max: '0', step: '0.1', value: '0' }); tx(r, 'r4.videoeditor.' + k, fb, 'aria-label'); return r; };
      this.rFrom = range('from', 'Início'); this.rTo = range('to', 'Fim'); this.oFrom = el('output', { class: 'r4-md-out', text: '0:00.0' }); this.oTo = el('output', { class: 'r4-md-out', text: '0:00.0' });
      this.rFrom.addEventListener('input', () => { if (+this.rFrom.value > +this.rTo.value) this.rTo.value = this.rFrom.value; this._range(); this.vid.currentTime = +this.rFrom.value; });
      this.rTo.addEventListener('input', () => { if (+this.rTo.value < +this.rFrom.value) this.rFrom.value = this.rTo.value; this._range(); });
      this.fmt = sel([['mp4', 'MP4 (H.264)'], ['webm', 'WebM (VP9)']]); this.fmt.value = this.format; tx(this.fmt, 'r4.videoeditor.format', 'Formato de saída', 'aria-label');
      this.size = sel([['0', TT(N, 'original', 'Original')], ['1920', '1080p'], ['1280', '720p'], ['854', '480p'], ['640', '360p']]); tx(this.size, 'r4.videoeditor.size', 'Tamanho', 'aria-label');
      this.rot = sel([['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]); tx(this.rot, 'r4.videoeditor.rotate', 'Girar', 'aria-label');
      this.speed = sel([['0.5', '0,5x'], ['1', '1x'], ['1.5', '1,5x'], ['2', '2x']]); this.speed.value = '1'; tx(this.speed, 'r4.videoeditor.speed', 'Velocidade', 'aria-label');
      this.filt = sel([['', TT(N, 'noFilter', 'Sem filtro')], ['grayscale(1)', TT(N, 'gray', 'Preto e branco')], ['sepia(1)', 'Sépia'], ['brightness(1.25)', TT(N, 'bright', 'Mais claro')], ['contrast(1.3)', TT(N, 'contrast', 'Mais contraste')], ['blur(2px)', TT(N, 'blur', 'Desfoque')]]); tx(this.filt, 'r4.videoeditor.filter', 'Filtro', 'aria-label');
      this.mute = el('input', { type: 'checkbox', class: 'r4-md-chk' }); const muteL = el('label', { class: 'r4-md-chkl' }, [this.mute, lbl(N, 'mute', 'Sem áudio')]);
      this.flip = el('input', { type: 'checkbox', class: 'r4-md-chk' }); const flipL = el('label', { class: 'r4-md-chkl' }, [this.flip, lbl(N, 'flip', 'Espelhar')]);
      this.bExport = btn('', N, 'export', 'Exportar', true); this.bCancel = btn('', N, 'cancel', 'Cancelar'); this.bCancel.hidden = true;
      this.bExport.addEventListener('click', () => this.exportar().catch(() => {})); this.bCancel.addEventListener('click', () => { if (this._abort) this._abort.abort(); });
      this.prog = el('progress', { class: 'r4-md-prog', max: '1', value: '0', hidden: true }); tx(this.prog, 'r4.videoeditor.progress', 'Progresso da exportação', 'aria-label');
      this.msgEl = el('div', { class: 'r4-md-msg', role: 'alert', hidden: true });
      this.strip = el('div', { class: 'r4-md-strip', 'aria-hidden': 'true' });
      this.resVid = el('video', { class: 'r4-md-video', controls: true, playsinline: true }); tx(this.resVid, 'r4.videoeditor.resultPlayer', 'Pré-visualização do resultado', 'aria-label');
      this.resLink = el('a', { class: 'r4-btn r4-btn-primary r4-md-btn', rel: 'noopener' }); this.resInfo = el('span', { class: 'r4-md-meta' });
      this.resBox = el('div', { class: 'r4-md-result', hidden: true }, [tx(el('div', { class: 'r4-md-lbl' }), 'r4.videoeditor.result', 'Resultado'), el('div', { class: 'r4-md-stage r4-md-vstage' }, [this.resVid]), el('div', { class: 'r4-md-bar' }, [this.resLink, this.resInfo])]);
      this._all = [this.rFrom, this.rTo, this.fmt, this.size, this.rot, this.speed, this.filt, this.mute, this.flip, this.bExport];
      this._ctl(false);
      R4.video.formats().then(ok => { [...this.fmt.options].forEach(o => { if (!ok.includes(o.value)) o.disabled = true; }); if (ok.length && !ok.includes(this.fmt.value)) this.fmt.value = ok[0]; }).catch(() => {});
      if (!sup.video) { this._msg(sup.message); this.fire('unsupported', this, sup.message); }
      return el('div', { class: 'r4-md r4-md-video' }, [this.stage, this.info, this.strip,
        el('div', { class: 'r4-md-bar' }, [lbl(N, 'from', 'Início'), this.rFrom, this.oFrom]), el('div', { class: 'r4-md-bar' }, [lbl(N, 'to', 'Fim'), this.rTo, this.oTo]),
        el('div', { class: 'r4-md-bar' }, [this.fmt, this.size, this.rot, this.speed, this.filt]), el('div', { class: 'r4-md-bar' }, [muteL, flipL]),
        el('div', { class: 'r4-md-bar' }, [this.bExport, this.bCancel, this.prog]), this.msgEl, this.resBox, this.fileIn]);
    },
    afterRender() {
      const on = (t, e, f) => { t.addEventListener(e, f); this._offs.push(() => t.removeEventListener(e, f)); };
      on(this.choose, 'click', () => this.fileIn.click()); dropZone(this.stage, f => this.load(f[0]).catch(() => {}));
      on(this.vid, 'timeupdate', () => { if (this._info && this.vid.currentTime > +this.rTo.value) { this.vid.pause(); this.vid.currentTime = +this.rFrom.value; } });
      if (this.src) this.load(this.src).catch(() => {});
    },
    _ctl() { const has = !!this._file, busy = !!this._busy; this._all.forEach(c => { c.disabled = !has || (busy && c !== this.bExport) || (c === this.bExport && busy); }); if (this.bCancel) this.bCancel.hidden = !busy; if (this.prog) this.prog.hidden = !busy; },
    _msg(m) { this.msgEl.textContent = m || ''; this.msgEl.hidden = !m; },
    _range() { this.oFrom.textContent = fmtT(+this.rFrom.value); this.oTo.textContent = fmtT(+this.rTo.value); },
    async load(src) {
      src = asFile(src); const tok = ++this._tok; this._msg('');
      try {
        if (!(src instanceof Blob)) throw new Error(TT('videoeditor', 'badSrc', 'Use um arquivo de vídeo.'));
        if (src.size > this.maxSize) throw new Error(TT('videoeditor', 'tooBig', 'Arquivo grande demais.'));
        const info = await R4.video.probe(src); if (tok !== this._tok || this._destroyed) return this;
        if (!info.hasVideo) throw new Error(TT('videoeditor', 'noVideo', 'O arquivo não tem vídeo.'));
        if (this._url) URL.revokeObjectURL(this._url); this._hideResult();
        this._file = src; this._info = info; this._url = URL.createObjectURL(src); this.vid.src = this._url; this._name = shown(src.name ? String(src.name).replace(/\.[^.]*$/, '') : this.name); this.emptyEl.hidden = true;
        [this.rFrom, this.rTo].forEach(r => { r.max = String(info.duration); }); this.rFrom.value = '0'; this.rTo.value = String(info.duration); this._range();
        this.info.textContent = info.width + 'x' + info.height + ' · ' + fmtT(info.duration) + ' · ' + info.fps + ' fps · ' + info.videoCodec + (info.hasAudio ? ' + ' + info.audioCodec : '');
        this._ctl(); this.fire('ready', this, info);
        R4.video.thumbnails(src, 8).then(list => { if (tok !== this._tok || this._destroyed) return; this.strip.replaceChildren(); list.forEach(b => { if (!b) return; const u = URL.createObjectURL(b), im = el('img', { class: 'r4-md-th', alt: '', src: u }); im.onload = () => URL.revokeObjectURL(u); this.strip.append(im); }); }).catch(() => {});
      } catch (e) { if (tok === this._tok && !this._destroyed) { this._msg(e.message); this.fire('error', this, e.message, e.code); } throw e; }
      return this;
    },
    options() { const o = { format: this.fmt.value, from: +this.rFrom.value, to: +this.rTo.value, rotate: +this.rot.value, speed: +this.speed.value, flip: this.flip.checked, audio: !this.mute.checked }; if (+this.size.value) o.width = +this.size.value; if (this.filt.value) o.filter = this.filt.value; return o; },
    async getBlob(extra) {
      if (!this._file) throw new Error(TT('videoeditor', 'noVideo', 'Nenhum vídeo carregado.'));
      this._abort = new AbortController(); this._busy = true; this._ctl(); this._msg(''); this.prog.value = 0;
      try { const r = await R4.video.transcode(this._file, Object.assign(this.options(), extra, { signal: this._abort.signal, onProgress: p => { this.prog.value = p; } })); this.blob = r.blob; this.fire('done', this, Object.assign({}, r.info, { blob: r.blob })); return r.blob; }
      catch (e) { if (e.code !== 'abort') { this._msg(e.message); this.fire('error', this, e.message, e.code); } else this._msg(TT('videoeditor', 'canceled', 'Exportação cancelada.')); throw e; }
      finally { this._busy = null; this._abort = null; if (!this._destroyed) this._ctl(); }
    },
    _showResult(b) {
      if (this._resUrl) URL.revokeObjectURL(this._resUrl);
      const f = this.fmt.value; this._resUrl = URL.createObjectURL(b); this.resVid.src = this._resUrl;
      this.resLink.href = this._resUrl; this.resLink.download = (this._name || 'video') + '-editado.' + f; this.resLink.textContent = TT('videoeditor', 'download', 'Baixar') + ' ' + f.toUpperCase();
      this.resInfo.textContent = R4.util.bytes(b.size); this.resBox.hidden = false;
    },
    _hideResult() { if (this._resUrl) { URL.revokeObjectURL(this._resUrl); this._resUrl = null; } if (this.resVid) { this.resVid.removeAttribute('src'); this.resVid.load(); } if (this.resBox) this.resBox.hidden = true; },
    async exportar() { this._hideResult(); const b = await this.getBlob(); if (!this._destroyed) this._showResult(b); return b; },
    async download() { try { const b = await this.getBlob(), f = this.fmt.value; R4.files && R4.files.download(b, (this._name || 'video') + '-editado.' + f, b.type); } catch (e) { /* já mostrado */ } return this; },
    destroy() { const was = this._destroyed; R4.Component.prototype.destroy.call(this); if (was || !this._destroyed) return this; this._tok++; if (this._abort) this._abort.abort(); (this._offs || []).splice(0).forEach(f => f()); try { this.vid.pause(); } catch (e) { /* ignora */ } if (this._url) URL.revokeObjectURL(this._url); this._hideResult(); this._url = null; this._file = null; return this; }
  }, {
    title: 'videoeditor', group: 'Mídia',
    description: 'Editor de vídeo no navegador, sem bibliotecas (WebCodecs + nossos demux/mux): pré-visualização, escolher o trecho, tamanho (1080p a 360p), girar, espelhar, velocidade, filtro, remover áudio e exportar em MP4 ou WebM com barra de progresso, cancelamento e pré-visualização do resultado antes de baixar. Tudo local: o arquivo não sai do computador do usuário.',
    props: [
      { name: 'src', type: 'File | Blob', default: 'null', desc: 'Vídeo a editar. Sem src, mostra "Escolher vídeo" e aceita arrastar/soltar.' },
      { name: 'format / height / maxSize / name', type: 'string / px / bytes', default: "'mp4' / 280 / 500 MB / 'video'", desc: 'Formato inicial, altura da pré-visualização, limite de tamanho e nome-base.' },
      { name: 'load(src) / options() / exportar() / getBlob(extra) / download()', type: 'método', desc: 'Carregar, ler as opções escolhidas, exportar (mostra o resultado com link de download), só gerar o arquivo ou baixar direto. extra é repassado para R4.video.transcode (ex.: draw, bitrate).' },
      { name: 'ready / done / error', type: 'evento', desc: 'ready(cmp, info) depois de abrir; done(cmp, info) ao exportar (info.blob traz o arquivo; também em .blob); error(cmp, mensagem, código).' }
    ],
    events: ['ready', 'done', 'error']
  });
  R4.registry.videoeditor.meta.playground = { html: '<r4-videoeditor{attrs}></r4-videoeditor>', cfg: {}, controls: { format: ['mp4', 'webm'], height: 280 } };
  if (R4.quickMap) R4.quickMap.videoeditor = (a, b) => (a && typeof a === 'object' && !(a instanceof Blob) ? a : Object.assign({ src: a }, b));

  /* ================= <r4-converter> ================= */
  R4.define('converter', {
    config: { accept: '', multiple: true, maxFiles: 20, maxSize: 500 * MB, to: '' },
    build() {
      need('convert', 'converter'); const N = 'converter'; this._offs = []; this._items = []; this._seq = 0;
      this.choose = btn('', N, 'choose', 'Escolher arquivos', true);
      this.drop = el('div', { class: 'r4-md-drop', tabindex: '0', role: 'button' }, [tx(el('span'), 'r4.converter.drop', 'Arraste arquivos aqui ou'), this.choose]);
      tx(this.drop, 'r4.converter.dropLabel', 'Área para soltar arquivos', 'aria-label');
      this.fileIn = picker(this.accept || '', !!this.multiple, f => this.add(f));
      this.list = el('ul', { class: 'r4-md-list', 'aria-live': 'polite' }); this.msgEl = el('div', { class: 'r4-md-msg', role: 'alert', hidden: true });
      return el('div', { class: 'r4-md r4-md-conv' }, [this.drop, this.list, this.msgEl, this.fileIn]);
    },
    afterRender() {
      const on = (t, e, f) => { t.addEventListener(e, f); this._offs.push(() => t.removeEventListener(e, f)); };
      on(this.choose, 'click', ev => { ev.stopPropagation(); this.fileIn.click(); }); on(this.drop, 'click', () => this.fileIn.click());
      on(this.drop, 'keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.fileIn.click(); } }); dropZone(this.drop, f => this.add(f));
    },
    _msg(m) { this.msgEl.textContent = m || ''; this.msgEl.hidden = !m; },
    load(f) { return this.add(f); },
    async add(files) {
      this._msg('');
      for (let f of [].concat(files)) {
        f = asFile(f); if (!f) continue;
        if (this._items.length >= this.maxFiles) { this._msg(TT('converter', 'tooMany', 'Máximo de arquivos atingido: ' + this.maxFiles, { n: this.maxFiles })); break; }
        if (f.size > this.maxSize) { this._msg(TT('converter', 'tooBig', 'Arquivo grande demais: ') + shown(f.name)); continue; }
        const it = { id: ++this._seq, file: f, state: 'idle' }; this._items.push(it); this._row(it);
        try { it.det = await R4.convert.detect(f); it.targets = it.det.kind ? await R4.convert.targets(f) : []; } catch (e) { it.targets = []; }
        this._row(it); if (this.to && it.targets.includes(this.to)) this.convert(it.id, this.to);
      }
      return this;
    },
    _row(it) {
      let li = this.list.querySelector('[data-id="' + it.id + '"]');
      if (!li) { li = el('li', { class: 'r4-md-item', 'data-id': String(it.id) }); this.list.append(li); }
      li.replaceChildren();
      const name = el('span', { class: 'r4-md-name', text: shown(it.file.name) }), meta = el('span', { class: 'r4-md-meta', text: (it.det && it.det.format ? it.det.format.toUpperCase() + ' · ' : '') + R4.util.bytes(it.file.size) });
      const head = el('div', { class: 'r4-md-itemhead' }, [name, meta]); li.append(head);
      const rm = btn('r4-md-x', 'converter', 'remove', 'Remover'); rm.addEventListener('click', () => { this._items = this._items.filter(x => x !== it); if (it.url) URL.revokeObjectURL(it.url); li.remove(); }); head.append(rm);
      if (it.state === 'working') { li.append(el('progress', { class: 'r4-md-prog' })); li.append(tx(el('span', { class: 'r4-md-meta' }), 'r4.converter.working', 'Convertendo...')); return; }
      if (it.state === 'done') {
        const a = el('a', { class: 'r4-btn r4-btn-primary r4-md-btn', href: it.url, download: it.result.name, rel: 'noopener' }); a.append(el('span', { text: TT('converter', 'download', 'Baixar') + ' ' + it.result.name + ' (' + R4.util.bytes(it.result.blob.size) + ')' })); li.append(a); return;
      }
      if (it.state === 'error') li.append(el('div', { class: 'r4-md-msg', role: 'alert', text: it.error }));
      if (!it.targets) return;
      if (!it.targets.length) { li.append(tx(el('span', { class: 'r4-md-meta' }), 'r4.converter.noTarget', 'Sem conversões disponíveis para este arquivo neste navegador.')); return; }
      const s = sel(it.targets.map(t => [t, t.toUpperCase()])); tx(s, 'r4.converter.target', 'Converter para', 'aria-label'); if (this.to && it.targets.includes(this.to)) s.value = this.to;
      const go = btn('', 'converter', 'convert', 'Converter', true); go.addEventListener('click', () => this.convert(it.id, s.value));
      li.append(el('div', { class: 'r4-md-bar' }, [lbl('converter', 'to', 'Converter para'), s, go]));
    },
    async convert(id, to) {
      const it = this._items.find(x => x.id === id); if (!it || it.state === 'working') return this;
      it.state = 'working'; this._row(it);
      try { const r = await R4.convert(it.file, to); if (this._destroyed || !this._items.includes(it)) return this; it.result = r; it.url = URL.createObjectURL(r.blob); it.state = 'done'; this.fire('done', this, r); }
      catch (e) { it.state = 'error'; it.error = e.message; this.fire('error', this, e.message, e.code); }
      if (!this._destroyed) this._row(it);
      return this;
    },
    destroy() { const was = this._destroyed; R4.Component.prototype.destroy.call(this); if (was || !this._destroyed) return this; (this._offs || []).splice(0).forEach(f => f()); (this._items || []).forEach(i => i.url && URL.revokeObjectURL(i.url)); this._items = []; return this; }
  }, {
    title: 'converter', group: 'Mídia',
    description: 'Conversor de arquivos no navegador: arraste ou escolha, o tipo é reconhecido pelo conteúdo, escolha o formato de saída (só aparecem os que este navegador consegue gerar) e baixe. Áudio, vídeo, imagem, MIDI e planilhas/dados. Nada é enviado a servidor.',
    props: [
      { name: 'accept / multiple / maxFiles / maxSize', type: 'string / boolean / number / bytes', default: "'' / true / 20 / 500 MB", desc: 'Filtro do seletor, vários arquivos, limites.' },
      { name: 'to', type: 'string', default: "''", desc: 'Formato de saída automático (ex.: to="mp3" não existe; to="wav" converte ao soltar o arquivo, quando possível).' },
      { name: 'add(arquivos) / load(arquivo) / convert(id, formato)', type: 'método', desc: 'Adicionar arquivos por código, ou por outra tag com r4-on="done:#conv.load" (aceita também { blob, name }), e converter um item da lista.' },
      { name: 'done / error', type: 'evento', desc: 'done(cmp, { blob, name, from, to }) por arquivo; error(cmp, mensagem, código).' }
    ],
    events: ['done', 'error']
  });
  R4.registry.converter.meta.playground = { html: '<r4-converter{attrs}></r4-converter>', cfg: {}, controls: { multiple: true, maxFiles: 20 } };
  if (R4.quickMap) R4.quickMap.converter = (a, b) => (a && typeof a === 'object' ? a : Object.assign({ to: a || '' }, b));

  /* ================= <r4-recorder> ================= */
  R4.define('recorder', {
    config: { source: 'mic', format: 'wav', maxTakes: 20, maxSeconds: 0, name: 'gravacao', meter: true },
    build() {
      const N = 'recorder'; this._offs = []; this._takes = []; this._seq = 0; this._acc = 0; this._t0 = 0; this._state = 'idle';
      this.bRec = btn('r4-md-rec-go', N, 'record', 'Gravar', true); this.bPause = btn('', N, 'pause', 'Pausar'); this.bStop = btn('', N, 'stop', 'Parar');
      this.bPause.disabled = this.bStop.disabled = true;
      this.timeEl = el('span', { class: 'r4-md-time', role: 'timer', 'aria-live': 'off', text: '0:00.0' });
      this.stateEl = el('span', { class: 'r4-md-meta r4-md-recstate' });
      this.cv = el('canvas', { class: 'r4-md-meter', height: 28, 'aria-hidden': 'true' });
      this.live = el('video', { class: 'r4-md-video r4-md-live', muted: true, playsinline: true, hidden: true }); this.live.muted = true;
      this.msgEl = el('div', { class: 'r4-md-msg', role: 'alert', hidden: true });
      this.list = el('ul', { class: 'r4-md-list', 'aria-live': 'polite' });
      const bar = el('div', { class: 'r4-md-bar' }, [this.bRec, this.bPause, this.bStop, this.timeEl, this.stateEl]);
      return el('div', { class: 'r4-md r4-md-rec' }, [bar, this.meter ? this.cv : null, this.live, this.msgEl, this.list].filter(Boolean));
    },
    afterRender() {
      const on = (t, e, f) => { t.addEventListener(e, f); this._offs.push(() => t.removeEventListener(e, f)); };
      on(this.bRec, 'click', () => { this.start().catch(() => {}); }); on(this.bStop, 'click', () => { this.stop().catch(() => {}); }); on(this.bPause, 'click', () => this.pause());
      this._sync(); this._drawMeter();
    },
    _msg(m) { this.msgEl.textContent = m || ''; this.msgEl.hidden = !m; },
    _src() { const s = String(this.source || 'mic').toLowerCase(); return s === 'screen' || s === 'camera' ? s : 'mic'; },
    getState() { return this._state; },
    _elapsed() { return this._acc + (this._state === 'recording' ? (performance.now() - this._t0) / 1000 : 0); },
    _sync() {
      const s = this._state, busy = s !== 'idle' && s !== 'starting';
      this.bRec.disabled = s !== 'idle'; this.bStop.disabled = !busy; this.bPause.disabled = !busy;
      tx(this.bPause, 'r4.recorder.' + (s === 'paused' ? 'resume' : 'pause'), s === 'paused' ? 'Continuar' : 'Pausar');
      this.bRec.classList.toggle('r4-md-recording', s === 'recording');
      this.stateEl.textContent = s === 'recording' ? TT('recorder', 'recording', 'Gravando') : s === 'paused' ? TT('recorder', 'paused', 'Pausado') : s === 'starting' ? TT('recorder', 'starting', 'Aguardando permissão...') : '';
      this.el && this.el.setAttribute('data-state', s);
    },
    _tick() {
      cancelAnimationFrame(this._raf); if (this._destroyed) return;
      this.timeEl.textContent = fmtT(this._elapsed());
      if (this.maxSeconds > 0 && this._state === 'recording' && this._elapsed() >= this.maxSeconds) { this.stop().catch(() => {}); return; }
      if (this._state !== 'idle') this._raf = requestAnimationFrame(() => this._tick());
    },
    _fail(e) {
      const n = e && e.name, code = n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'noDevice' : (e && e.code) || 'error';
      const fb = { denied: 'Permissão negada. Libere o acesso no navegador e tente de novo.', noDevice: 'Nenhum dispositivo encontrado (microfone, câmera ou tela).', unsupported: 'Este navegador não grava mídia.', insecure: 'A gravação exige HTTPS (ou localhost).', error: (e && e.message) || 'Não foi possível gravar.' };
      const m = TT('recorder', code, fb[code] || fb.error); this._msg(m); this.fire('error', this, m, code); return m;
    },
    async start() {
      if (this._destroyed || this._state !== 'idle') return this;
      this._msg(''); const src = this._src();
      if (typeof window !== 'undefined' && window.isSecureContext === false) { this._fail({ code: 'insecure' }); throw new Error('insecure'); }
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') { this._fail({ code: 'unsupported' }); throw new Error('unsupported'); }
      if (this._takes.length >= this.maxTakes) { const m = TT('recorder', 'tooMany', 'Máximo de gravações atingido.'); this._msg(m); this.fire('error', this, m, 'limit'); return this; }
      this._state = 'starting'; this._sync();
      try {
        need('audio', 'recorder');
        if (src === 'mic') this._rec = await R4.audio.record(); else { need('video', 'recorder'); this._rec = await R4.video.record({ source: src }); }
      } catch (e) { this._state = 'idle'; this._sync(); this._fail(e); throw e; }
      if (this._destroyed) { this._rec.cancel(); return this; }
      this._src_ = src; this._acc = 0; this._t0 = performance.now(); this._state = 'recording';
      const st = this._rec.stream; if (src !== 'mic' && st) { this.live.srcObject = st; this.live.hidden = false; this.live.play && this.live.play().catch(() => {}); }
      if (src !== 'mic' && st) st.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (this._state !== 'idle') this.stop().catch(() => {}); }));
      this._meterOpen(st); this._sync(); this._tick(); this.fire('start', this);
      return this;
    },
    pause() {
      if (!this._rec) return this;
      if (this._state === 'recording') { this._acc = this._elapsed(); this._rec.pause(); this._state = 'paused'; this.fire('pause', this); }
      else if (this._state === 'paused') { this._t0 = performance.now(); this._rec.resume(); this._state = 'recording'; this.fire('resume', this); }
      this._sync(); this._tick(); return this;
    },
    async stop() {
      const rec = this._rec; if (!rec || this._state === 'idle') return null;
      const dur = this._elapsed(), src = this._src_; this._rec = null; this._state = 'idle'; this._meterClose(); this.live.hidden = true; this.live.srcObject = null; this._sync(); this.timeEl.textContent = fmtT(dur);
      let blob;
      try {
        if (src === 'mic') {
          const raw = await rec.stopBlob(); blob = raw;
          if (this.format !== 'raw' && R4.audio && raw.size) { try { blob = await R4.audio.encode(await R4.audio.decode(raw), this.format || 'wav'); } catch (e) { blob = raw; } }
        } else blob = await rec.stop();
      } catch (e) { this._fail(e); throw e; }
      if (this._destroyed) return blob;
      if (!blob || !blob.size) { const m = TT('recorder', 'empty', 'A gravação ficou vazia.'); this._msg(m); this.fire('error', this, m, 'empty'); return null; }
      const info = { source: src, duration: dur, size: blob.size, type: blob.type, name: this.name + '-' + (this._seq + 1) };
      const take = Object.assign({ id: ++this._seq, blob, url: URL.createObjectURL(blob) }, info); this._takes.push(take); this.blob = blob; this._row(take);
      this.fire('stop', this); this.fire('done', this, blob, info);
      return blob;
    },
    getBlob() { return this.blob || null; },
    discard(id) {
      const i = this._takes.findIndex(t => t.id === id); if (i < 0) return this;
      const t = this._takes[i]; this._takes.splice(i, 1); URL.revokeObjectURL(t.url);
      const li = this.list.querySelector('[data-id="' + id + '"]'); if (li) li.remove();
      if (this.blob === t.blob) this.blob = this._takes.length ? this._takes[this._takes.length - 1].blob : null; return this;
    },
    takes() { return this._takes.map(t => ({ id: t.id, name: t.name, duration: t.duration, size: t.size, type: t.type, source: t.source, blob: t.blob })); },
    _row(t) {
      const li = el('li', { class: 'r4-md-item', 'data-id': String(t.id) });
      const media = el(t.source === 'mic' ? 'audio' : 'video', { class: t.source === 'mic' ? 'r4-md-player' : 'r4-md-video', controls: true, preload: 'metadata', src: t.url });
      tx(media, 'r4.recorder.player', 'Reproduzir gravação', 'aria-label');
      const ext = (t.type.split(';')[0].split('/')[1] || 'bin').replace('x-wav', 'wav').replace('mpeg', 'mp3');
      const a = el('a', { class: 'r4-btn r4-md-btn', href: t.url, download: t.name + '.' + ext, rel: 'noopener' }); tx(a, 'r4.recorder.download', 'Baixar');
      const rm = btn('r4-md-x', 'recorder', 'discard', 'Descartar'); rm.addEventListener('click', () => this.discard(t.id));
      li.append(el('div', { class: 'r4-md-itemhead' }, [el('span', { class: 'r4-md-name', text: shown(t.name) }), el('span', { class: 'r4-md-meta', text: fmtT(t.duration) + ' · ' + R4.util.bytes(t.size) + ' · ' + ext.toUpperCase() })]), media, el('div', { class: 'r4-md-bar' }, [a, rm]));
      this.list.append(li);
    },
    _meterOpen(stream) {
      this._meterClose(); if (!this.meter || !stream || !stream.getAudioTracks().length) return;
      try { const AC = window.AudioContext || window.webkitAudioContext, ac = new AC(), src = ac.createMediaStreamSource(stream), an = ac.createAnalyser(); an.fftSize = 512; src.connect(an); this._ac = ac; this._an = an; this._lv = new Uint8Array(an.fftSize); } catch (e) { this._ac = null; }
    },
    _meterClose() { if (this._ac) { try { this._ac.close(); } catch (e) { /* já fechado */ } } this._ac = null; this._an = null; this._level = 0; },
    level() { return this._level || 0; },
    _drawMeter() {
      if (this._destroyed || !this.meter) return;
      const cv = this.cv, w = cv.clientWidth || 300, dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(28 * dpr); }
      const cx = cv.getContext('2d'), cs = getComputedStyle(cv), W = cv.width, H = cv.height;
      if (this._an && this._state === 'recording') {
        this._an.getByteTimeDomainData(this._lv); let pk = 0; for (let i = 0; i < this._lv.length; i++) pk = Math.max(pk, Math.abs(this._lv[i] - 128));
        const v = Math.min(1, pk / 128); this._level = v; this._smooth = Math.max(v, (this._smooth || 0) * 0.9);
      } else { this._level = 0; this._smooth = (this._smooth || 0) * 0.85; }
      cx.clearRect(0, 0, W, H); cx.fillStyle = cs.getPropertyValue('--r4-line').trim() || '#ccc'; cx.fillRect(0, 0, W, H);
      const lv = this._smooth || 0; cx.fillStyle = lv > 0.9 ? (cs.getPropertyValue('--r4-err').trim() || '#e03131') : (cs.getPropertyValue('--r4-acc').trim() || '#3b5bdb'); cx.fillRect(0, 0, W * lv, H);
      this._mraf = requestAnimationFrame(() => this._drawMeter());
    },
    destroy() {
      const was = this._destroyed; R4.Component.prototype.destroy.call(this); if (was || !this._destroyed) return this;
      cancelAnimationFrame(this._raf); cancelAnimationFrame(this._mraf); if (this._rec) { try { this._rec.cancel(); } catch (e) { /* já parou */ } this._rec = null; }
      this._meterClose(); (this._offs || []).splice(0).forEach(f => f()); this._takes.forEach(t => URL.revokeObjectURL(t.url)); this._takes = []; this.blob = null; return this;
    }
  }, {
    title: 'recorder', group: 'Mídia',
    description: 'Gravador no navegador, sem bibliotecas: microfone (padrão), tela ou câmera. Botões gravar, pausar e parar, cronômetro, medidor de nível ao vivo, lista de gravações com player, baixar e descartar. Pede permissão ao usuário e avisa com clareza quando não há microfone, a permissão foi negada ou a página não é segura (exige HTTPS ou localhost). Nada é enviado a servidor.',
    props: [
      { name: 'source', type: "'mic' | 'screen' | 'camera'", default: "'mic'", desc: 'O que gravar. mic gera áudio (WAV por padrão); screen e camera geram vídeo WebM/MP4 pelo navegador.' },
      { name: 'format', type: "'wav' | 'flac' | 'opus' | 'raw'", default: "'wav'", desc: 'Formato do áudio do microfone (raw guarda o que o navegador gravou, sem converter).' },
      { name: 'maxTakes / maxSeconds', type: 'número', default: '20 / 0', desc: 'Máximo de gravações na lista e duração máxima de cada uma em segundos (0 = sem limite).' },
      { name: 'meter / name', type: 'boolean / string', default: "true / 'gravacao'", desc: 'Medidor de nível ao vivo e nome-base dos arquivos.' },
      { name: 'start() / pause() / stop() / getBlob() / getState() / discard(id) / takes() / level()', type: 'método', desc: 'start pede permissão e começa; pause alterna pausa/continuar; stop encerra e devolve o Blob; getBlob e .blob dão a última gravação; takes() lista todas; level() é o nível atual (0 a 1).' },
      { name: 'start / pause / resume / stop / done / error', type: 'evento', desc: 'done(cmp, blob, {source, duration, size, type, name}) a cada gravação pronta: r4-on="done:#ed.load" manda para um <r4-audioeditor id="ed">. error(cmp, mensagem, código): denied, noDevice, unsupported, insecure, empty, limit.' },
      { name: 'r4-click="download:#id"', type: 'ação', desc: 'Baixa a última gravação.' }
    ],
    events: ['start', 'pause', 'resume', 'stop', 'done', 'error']
  });
  R4.registry.recorder.meta.playground = { html: '<r4-recorder{attrs}></r4-recorder>', cfg: {}, controls: { source: ['mic', 'screen', 'camera'], format: ['wav', 'flac', 'opus', 'raw'], maxSeconds: 0 } };
  if (R4.quickMap) R4.quickMap.recorder = (a, b) => (a && typeof a === 'object' ? a : Object.assign({ source: a || 'mic' }, b));

  /* ================= <r4-piano> ================= */
  R4.define('piano', {
    config: { octaves: 2, start: 3, wave: 'piano', volume: 0.5 },
    build() {
      need('music', 'piano'); this._offs = []; this._down = new Map(); this._inst = null;
      const WHITE = [0, 2, 4, 5, 7, 9, 11], BLACK = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 }, n = clamp(+this.octaves || 2, 1, 7), s = clamp(+this.start, 0, 7);
      this.keys = el('div', { class: 'r4-md-keys', role: 'group', tabindex: '0' }); tx(this.keys, 'r4.piano.label', 'Teclado de piano', 'aria-label');
      const KEYS = 'awsedftgyhujkolpç'.split(''); this._map = {}; let ki = 0;
      for (let o = 0; o < n; o++) {
        WHITE.forEach((pc, i) => {
          const midi = (s + o + 1) * 12 + pc, name = R4.music.note(midi).name, k = el('button', { type: 'button', class: 'r4-md-key r4-md-white', 'data-midi': String(midi), 'aria-label': name, text: o === 0 && i === 0 || i === 0 ? name : '' }); this.keys.append(k);
          if (BLACK[i] != null) { const bm = (s + o + 1) * 12 + BLACK[i], bk = el('button', { type: 'button', class: 'r4-md-key r4-md-black', 'data-midi': String(bm), 'aria-label': R4.music.note(bm).name, style: { left: 'calc(' + ((o * 7 + i + 1) / (n * 7) * 100) + '% - 2.2%)' } }); this.keys.append(bk); }
        });
      }
      [...this.keys.children].sort((a, b) => +a.dataset.midi - +b.dataset.midi).forEach(k => { if (ki < KEYS.length) this._map[KEYS[ki++]] = +k.dataset.midi; });
      return el('div', { class: 'r4-md r4-md-piano' }, [this.keys]);
    },
    afterRender() {
      const on = (t, e, f, o) => { t.addEventListener(e, f, o); this._offs.push(() => t.removeEventListener(e, f, o)); };
      const midiOf = t => { const k = t && t.closest ? t.closest('.r4-md-key') : null; return k ? +k.dataset.midi : null; };
      on(this.keys, 'pointerdown', ev => { const m = midiOf(ev.target); if (m == null) return; ev.preventDefault(); try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* ignora */ } this._down.set(ev.pointerId, m); this.noteOn(m); });
      on(this.keys, 'pointermove', ev => { if (!this._down.has(ev.pointerId)) return; const m = midiOf(document.elementFromPoint(ev.clientX, ev.clientY)); const cur = this._down.get(ev.pointerId); if (m != null && m !== cur) { this.noteOff(cur); this._down.set(ev.pointerId, m); this.noteOn(m); } });
      const up = ev => { const m = this._down.get(ev.pointerId); if (m != null) { this._down.delete(ev.pointerId); this.noteOff(m); } };
      on(this.keys, 'pointerup', up); on(this.keys, 'pointercancel', up);
      const kd = ev => { if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return; const t = ev.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; if (!this.keys.contains(t) && !this.keys.matches(':hover')) return; const m = this._map[ev.key.toLowerCase()]; if (m != null) { ev.preventDefault(); this.noteOn(m); } };
      const ku = ev => { const m = this._map[ev.key.toLowerCase()]; if (m != null) this.noteOff(m); };
      on(document, 'keydown', kd); on(document, 'keyup', ku); on(window, 'blur', () => this.allOff());
    },
    _key(m) { return this.keys.querySelector('[data-midi="' + m + '"]'); },
    noteOn(n, vel) {
      const m = Math.round(R4.music.note(n).midi);
      try { if (!this._inst) this._inst = R4.music.instrument({ wave: this.wave, volume: this.volume }); this._inst.noteOn(m, vel); } catch (e) { this.fire('error', this, e.message, e.code); return this; }
      const k = this._key(m); if (k) k.classList.add('r4-md-on'); this.fire('note', this, R4.music.note(m), true); return this;
    },
    noteOff(n) { const m = Math.round(R4.music.note(n).midi); if (this._inst) this._inst.noteOff(m); const k = this._key(m); if (k) k.classList.remove('r4-md-on'); this.fire('note', this, R4.music.note(m), false); return this; },
    allOff() { if (this._inst) this._inst.allOff(); this._down.clear(); this.keys.querySelectorAll('.r4-md-on').forEach(k => k.classList.remove('r4-md-on')); return this; },
    destroy() { const was = this._destroyed; R4.Component.prototype.destroy.call(this); if (was || !this._destroyed) return this; (this._offs || []).splice(0).forEach(f => f()); if (this._inst) { this._inst.destroy(); this._inst = null; } return this; }
  }, {
    title: 'piano', group: 'Mídia',
    description: 'Teclado de piano com som sintetizado (WebAudio): mouse, toque (deslizar entre teclas) e teclado do computador (A W S E D F T G Y H U J K O L P Ç). Escolha o timbre (piano, órgão, seno, quadrada, serra, triângulo). O som só começa após o primeiro toque/tecla (regra dos navegadores).',
    props: [
      { name: 'octaves / start', type: 'number', default: '2 / 3', desc: 'Quantidade de oitavas (1 a 7) e oitava inicial (0 a 7).' },
      { name: 'wave / volume', type: "'piano'|'organ'|'sine'|'square'|'saw'|'triangle' / 0..1", default: "'piano' / 0.5", desc: 'Timbre e volume.' },
      { name: 'noteOn(nota, vel) / noteOff(nota) / allOff()', type: 'método', desc: 'Tocar por código; nota é "C4" ou número MIDI.' },
      { name: 'note', type: 'evento', desc: 'note(cmp, {name, midi, hz}, ligada) a cada nota ligada/desligada.' }
    ],
    events: ['note', 'error']
  });
  R4.registry.piano.meta.playground = { html: '<r4-piano{attrs}></r4-piano>', cfg: {}, controls: { octaves: 2, start: 3, wave: ['piano', 'organ', 'sine', 'square', 'saw', 'triangle'], volume: 0.5 } };

  /* ================= i18n ================= */
  if (R4.i18n && R4.i18n.add) {
    R4.i18n.add('pt-BR', { r4: {
      audioeditor: { choose: 'Escolher áudio', empty: 'Nenhum áudio carregado. Arraste um arquivo ou', play: 'Tocar', pause: 'Parar', stop: 'Parar', trim: 'Manter seleção', cut: 'Remover seleção', fadeIn: 'Fade-in', fadeOut: 'Fade-out', normalize: 'Normalizar', reverse: 'Inverter', silence: 'Tirar silêncios', undo: 'Desfazer', redo: 'Refazer', gain: 'Ganho (dB)', apply: 'Aplicar ganho', format: 'Formato de saída', export: 'Baixar', area: 'Forma de onda: arraste para selecionar um trecho; espaço toca; setas movem a seleção', tooBig: 'Arquivo grande demais.', noAudio: 'Nenhum áudio carregado.' },
      videoeditor: { choose: 'Escolher vídeo', empty: 'Nenhum vídeo carregado. Arraste um arquivo ou', from: 'Início', to: 'Fim', format: 'Formato de saída', size: 'Tamanho', rotate: 'Girar', speed: 'Velocidade', filter: 'Filtro', mute: 'Sem áudio', flip: 'Espelhar', export: 'Exportar', result: 'Resultado', resultPlayer: 'Pré-visualização do resultado', download: 'Baixar', cancel: 'Cancelar', player: 'Pré-visualização do vídeo', progress: 'Progresso da exportação', original: 'Original', noFilter: 'Sem filtro', gray: 'Preto e branco', bright: 'Mais claro', contrast: 'Mais contraste', blur: 'Desfoque', badSrc: 'Use um arquivo de vídeo.', tooBig: 'Arquivo grande demais.', noVideo: 'O arquivo não tem vídeo.', canceled: 'Exportação cancelada.' },
      converter: { choose: 'Escolher arquivos', drop: 'Arraste arquivos aqui ou', dropLabel: 'Área para soltar arquivos', remove: 'Remover', convert: 'Converter', to: 'Converter para', target: 'Converter para', working: 'Convertendo...', download: 'Baixar', noTarget: 'Sem conversões disponíveis para este arquivo neste navegador.', tooBig: 'Arquivo grande demais: ', tooMany: 'Máximo de {n} arquivos atingido.' },
      recorder: { record: 'Gravar', pause: 'Pausar', resume: 'Continuar', stop: 'Parar', recording: 'Gravando', paused: 'Pausado', starting: 'Aguardando permissão...', download: 'Baixar', discard: 'Descartar', player: 'Reproduzir gravação', denied: 'Permissão negada. Libere o acesso no navegador e tente de novo.', noDevice: 'Nenhum dispositivo encontrado (microfone, câmera ou tela).', unsupported: 'Este navegador não grava mídia.', insecure: 'A gravação exige HTTPS (ou localhost).', empty: 'A gravação ficou vazia.', tooMany: 'Máximo de gravações atingido.' },
      piano: { label: 'Teclado de piano' } } });
    R4.i18n.add('en', { r4: {
      audioeditor: { choose: 'Choose audio', empty: 'No audio loaded. Drop a file or', play: 'Play', pause: 'Stop', stop: 'Stop', trim: 'Keep selection', cut: 'Remove selection', fadeIn: 'Fade in', fadeOut: 'Fade out', normalize: 'Normalize', reverse: 'Reverse', silence: 'Remove silence', undo: 'Undo', redo: 'Redo', gain: 'Gain (dB)', apply: 'Apply gain', format: 'Output format', export: 'Download', area: 'Waveform: drag to select a range; space plays; arrows move the selection', tooBig: 'File too large.', noAudio: 'No audio loaded.' },
      videoeditor: { choose: 'Choose video', empty: 'No video loaded. Drop a file or', from: 'Start', to: 'End', format: 'Output format', size: 'Size', rotate: 'Rotate', speed: 'Speed', filter: 'Filter', mute: 'No audio', flip: 'Mirror', export: 'Export', result: 'Result', resultPlayer: 'Result preview', download: 'Download', cancel: 'Cancel', player: 'Video preview', progress: 'Export progress', original: 'Original', noFilter: 'No filter', gray: 'Black and white', bright: 'Brighter', contrast: 'More contrast', blur: 'Blur', badSrc: 'Use a video file.', tooBig: 'File too large.', noVideo: 'The file has no video.', canceled: 'Export canceled.' },
      converter: { choose: 'Choose files', drop: 'Drop files here or', dropLabel: 'Drop area for files', remove: 'Remove', convert: 'Convert', to: 'Convert to', target: 'Convert to', working: 'Converting...', download: 'Download', noTarget: 'No conversions available for this file in this browser.', tooBig: 'File too large: ', tooMany: 'Maximum of {n} files reached.' },
      recorder: { record: 'Record', pause: 'Pause', resume: 'Resume', stop: 'Stop', recording: 'Recording', paused: 'Paused', starting: 'Waiting for permission...', download: 'Download', discard: 'Discard', player: 'Play recording', denied: 'Permission denied. Allow access in the browser and try again.', noDevice: 'No device found (microphone, camera or screen).', unsupported: 'This browser cannot record media.', insecure: 'Recording needs HTTPS (or localhost).', empty: 'The recording is empty.', tooMany: 'Recording limit reached.' },
      piano: { label: 'Piano keyboard' } } });
  }
})(window.R4);
