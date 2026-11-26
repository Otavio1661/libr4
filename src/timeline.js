/**
 * ============================================
 * libr4 / timeline.js  —  R4 dev
 * ============================================
 * R4.timeline: projeto de edição multicamadas em JSON, sem bibliotecas.
 *  Modelo: { width, height, fps, assets{}, bins[], tracks[{id,kind,clips[]}], markers[] }.
 *  Operações: addTrack/addClip/split (razor)/trim/ripple/slip/slide/move/duplicate/remove, marcadores, histórico undo/redo.
 *  Tempo: keyframes com easing e Bézier, rampa de velocidade, reverso (value, srcTime).
 *  Texto: parseSubs/toSRT/toVTT, subsToClips, edição por transcrição (cutRanges).
 *  Intercâmbio: toEDL/fromEDL (CMX3600), toXML/fromXML (FCP XML), timecode.
 *  Composição e exportação: ver segunda parte do arquivo (compose, mixAudio, render, preview).
 * Em "tracks" a ordem do array é a ordem de empilhamento (0 = fundo).
 * ============================================
 */
(function (R4) {
  'use strict';
  const fail = (m, code) => { const e = new Error(m); if (code) e.code = code; throw e; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const EPS = 1e-6;
  let uid = 0;
  const newId = p => p + (++uid).toString(36) + Math.floor(Math.random() * 1679616).toString(36);
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ================= easing e keyframes ================= */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = t => ((ax * t + bx) * t + cx) * t, Y = t => ((ay * t + by) * t + cy) * t;
    const dX = t => (3 * ax * t + 2 * bx) * t + cx;
    return x => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) { const e = X(t) - x; if (Math.abs(e) < 1e-6) return Y(t); const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
      let lo = 0, hi = 1; t = x;
      for (let i = 0; i < 24; i++) { const e = X(t); if (Math.abs(e - x) < 1e-6) break; if (e < x) lo = t; else hi = t; t = (lo + hi) / 2; }
      return Y(t);
    };
  }
  const bounceOut = x => { const n = 7.5625, d = 2.75; if (x < 1 / d) return n * x * x; if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75; if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375; return n * (x -= 2.625 / d) * x + 0.984375; };
  const EASE = {
    linear: x => x, hold: x => (x < 1 ? 0 : 1),
    in: x => x * x * x, out: x => 1 - Math.pow(1 - x, 3),
    inOut: x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    sine: x => -(Math.cos(Math.PI * x) - 1) / 2,
    back: x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
    bounce: bounceOut, elastic: x => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (2 * Math.PI / 3)) + 1)
  };
  function easeFn(k) {
    if (k && Array.isArray(k.bezier) && k.bezier.length === 4) return bezier(...k.bezier.map(v => num(v, 0)));
    return EASE[k && k.ease] || EASE.linear;
  }
  /** Valor animado de uma propriedade no tempo local t (s). Sem keyframes devolve `base`. */
  function track(keys, t, base) {
    if (!Array.isArray(keys) || !keys.length) return base;
    if (t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 1; i < keys.length; i++) {
      const b = keys[i];
      if (t <= b.t) {
        const a = keys[i - 1], span = b.t - a.t || EPS;
        return a.v + (b.v - a.v) * easeFn(a)((t - a.t) / span);
      }
    }
    return last.v;
  }
  const DEF_TF = { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
  /** Valor de uma propriedade de transform/volume/pan no tempo local do clipe. */
  function value(clip, prop, t) {
    const base = clip.transform && prop in clip.transform ? clip.transform[prop]
      : (prop in clip ? clip[prop] : (DEF_TF[prop] != null ? DEF_TF[prop] : (prop === 'volume' ? 1 : 0)));
    return track(clip.keys && clip.keys[prop], t, base);
  }

  /* ================= tempo da fonte (velocidade, rampa, reverso) ================= */
  function rampSpeed(clip, t) {
    const r = clip.ramp;
    if (!r || !r.length) return clip.speed || 1;
    return track(r.map(p => ({ t: p.t, v: p.speed, ease: p.ease })), t, clip.speed || 1);
  }
  function rampIntegral(clip, t) {
    const r = clip.ramp;
    if (!r || !r.length) return (clip.speed || 1) * t;
    const n = Math.max(8, Math.ceil(t * 60));
    let s = 0, prev = rampSpeed(clip, 0);
    for (let i = 1; i <= n; i++) { const tt = t * i / n, cur = rampSpeed(clip, tt); s += (prev + cur) / 2 * (t / n); prev = cur; }
    return s;
  }
  /** Tempo (s) dentro da mídia de origem para o tempo local t do clipe. */
  function srcTime(clip, t) {
    const local = clamp(t, 0, clip.dur);
    if (clip.reverse) return (clip.in || 0) + rampIntegral(clip, clip.dur) - rampIntegral(clip, local);
    return (clip.in || 0) + rampIntegral(clip, local);
  }
  /** Quanto da mídia (s) o clipe consome. */
  const srcSpan = clip => rampIntegral(clip, clip.dur);

  /* ================= timecode ================= */
  function tc(sec, fps) {
    fps = fps || 30; const f = Math.round(Math.max(0, sec) * fps), r = Math.round(fps);
    const pad = n => String(n).padStart(2, '0');
    return pad(Math.floor(f / (r * 3600))) + ':' + pad(Math.floor(f / (r * 60)) % 60) + ':' + pad(Math.floor(f / r) % 60) + ':' + pad(f % r);
  }
  function parseTC(s, fps) {
    const m = /^(\d+):(\d\d):(\d\d)[:;](\d\d)$/.exec(String(s).trim());
    if (!m) fail('Timecode inválido: ' + s);
    return (+m[1] * 3600 + +m[2] * 60 + +m[3]) + +m[4] / (fps || 30);
  }

  /* ================= legendas ================= */
  function parseTime(s) {
    const m = /^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d{1,3}))?$/.exec(s.trim());
    if (!m) return NaN;
    return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +('0.' + m[4].padEnd(3, '0')) : 0);
  }
  /** Lê SRT ou WebVTT. Devolve [{start, end, text}] (texto sem marcação). */
  function parseSubs(text) {
    if (typeof text !== 'string') fail('Legenda inválida.');
    if (text.length > 5e6) fail('Arquivo de legenda grande demais.', 'limit');
    const cues = [];
    const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split('\n').filter(l => l.length);
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const mm = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
      if (!mm) continue;
      const start = parseTime(mm[1]), end = parseTime(mm[2]);
      if (!isFinite(start) || !isFinite(end) || end <= start) continue;
      const body = lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
      if (body) cues.push({ start, end, text: body });
    }
    return cues;
  }
  const fmtT = (t, sep) => {
    const ms = Math.round(Math.max(0, t) * 1000), p = (n, l) => String(n).padStart(l || 2, '0');
    return p(Math.floor(ms / 3600000)) + ':' + p(Math.floor(ms / 60000) % 60) + ':' + p(Math.floor(ms / 1000) % 60) + sep + p(ms % 1000, 3);
  };
  const toSRT = cues => cues.map((c, i) => (i + 1) + '\n' + fmtT(c.start, ',') + ' --> ' + fmtT(c.end, ',') + '\n' + c.text + '\n').join('\n');
  const toVTT = cues => 'WEBVTT\n\n' + cues.map(c => fmtT(c.start, '.') + ' --> ' + fmtT(c.end, '.') + '\n' + c.text + '\n').join('\n');

  /* ================= EDL e XML ================= */
  function xmlEsc(s) { return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])); }
  /** Leitor XML mínimo (sem DOM, sem entidades externas): devolve {name, attrs, children, text}. */
  function parseXML(src) {
    if (src.length > 2e7) fail('XML grande demais.', 'limit');
    const dec = s => s.replace(/&(lt|gt|amp|quot|apos);/g, (m, k) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[k]));
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const root = { name: '#root', attrs: {}, children: [], text: '' }, st = [root];
    let m, depth = 0;
    while ((m = re.exec(src))) {
      if (m[5] !== undefined) { st[st.length - 1].text += dec(m[5]); continue; }
      if (m[2] === undefined) continue;
      if (m[1]) { if (st.length > 1) st.pop(); depth--; continue; }
      const attrs = {}; String(m[3] || '').replace(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (x, k, v, a, b) => { attrs[k] = dec(a != null ? a : b); return ''; });
      const node = { name: m[2], attrs, children: [], text: '' };
      st[st.length - 1].children.push(node);
      if (!m[4]) { if (++depth > 200) fail('XML profundo demais.', 'limit'); st.push(node); }
    }
    return root.children[0] || root;
  }
  const kid = (n, name) => n.children.find(c => c.name === name);
  const kids = (n, name) => n.children.filter(c => c.name === name);
  const ktext = (n, name, d) => { const k = n && kid(n, name); return k ? k.text.trim() : d; };

  /* ================= projeto ================= */
  function sortedClips(tr) { return tr.clips.slice().sort((a, b) => a.start - b.start); }
  const clipEnd = c => c.start + c.dur;

  function create(data) {
    data = data || {};
    const P = {
      width: clamp(num(data.width, 1280) | 0, 16, 7680), height: clamp(num(data.height, 720) | 0, 16, 4320), fps: clamp(num(data.fps, 30), 1, 240),
      assets: data.assets || {}, bins: clone(data.bins || []), tracks: clone(data.tracks || []), markers: clone(data.markers || []), background: data.background || '#000000'
    };
    const undo = [], redo = [], listeners = [];
    const snap = () => JSON.stringify({ tracks: P.tracks, markers: P.markers, bins: P.bins, width: P.width, height: P.height, fps: P.fps, background: P.background });
    const apply = s => { const o = JSON.parse(s); P.tracks = o.tracks; P.markers = o.markers; P.bins = o.bins; P.width = o.width; P.height = o.height; P.fps = o.fps; P.background = o.background; };
    const emit = (why) => { for (const f of listeners) try { f(why, P); } catch (e) { /* ouvinte não derruba a edição */ } };
    /** Roda uma edição como uma única entrada do histórico. */
    function tx(why, fn) {
      const before = snap();
      const r = fn();
      const after = snap();
      if (after !== before) { undo.push(before); if (undo.length > 200) undo.shift(); redo.length = 0; emit(why); }
      return r;
    }
    const findTrack = id => P.tracks.find(t => t.id === id);
    function find(id) {
      for (const t of P.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { track: t, clip: c }; }
      fail('Clipe não encontrado: ' + id);
    }
    const norm = c => {
      c.id = c.id || newId('c'); c.type = c.type || 'video';
      c.start = Math.max(0, num(c.start, 0)); c.dur = Math.max(EPS, num(c.dur, 1)); c.in = Math.max(0, num(c.in, 0)); c.speed = num(c.speed, 1) > 0 ? c.speed : 1;
      return c;
    };

    const T = {
      project: P,
      on(f) { listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; },
      get duration() { let d = 0; for (const t of P.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c)); return d; },
      get canUndo() { return undo.length > 0; }, get canRedo() { return redo.length > 0; },
      undo() { if (!undo.length) return false; redo.push(snap()); apply(undo.pop()); emit('undo'); return true; },
      redo() { if (!redo.length) return false; undo.push(snap()); apply(redo.pop()); emit('redo'); return true; },
      tx,

      /* ---- assets, bins, busca ---- */
      addAsset(a) {
        if (!a || !a.kind) fail('Mídia inválida.');
        const id = a.id || newId('a'); P.assets[id] = Object.assign({ tags: [], duration: 0 }, a, { id });
        emit('asset'); return id;
      },
      addBin(name) { return tx('bin', () => { const b = { id: newId('b'), name: String(name || 'Pasta'), assets: [] }; P.bins.push(b); return b.id; }); },
      tag(assetId, tags) { const a = P.assets[assetId]; if (!a) fail('Mídia inválida.'); a.tags = Array.from(new Set((a.tags || []).concat(tags))); emit('tag'); },
      moveToBin(assetId, binId) {
        tx('bin', () => { for (const b of P.bins) b.assets = b.assets.filter(x => x !== assetId); const b = P.bins.find(x => x.id === binId); if (b) b.assets.push(assetId); });
      },
      /** Busca por nome/tag nas mídias e por nome nos marcadores e clipes. */
      search(q) {
        q = String(q || '').toLowerCase().trim(); if (!q) return { assets: [], markers: [], clips: [] };
        const has = s => String(s || '').toLowerCase().includes(q);
        return {
          assets: Object.values(P.assets).filter(a => has(a.name) || (a.tags || []).some(has)),
          markers: P.markers.filter(m => has(m.name)),
          clips: P.tracks.flatMap(t => t.clips).filter(c => has(c.name) || (c.text && has(c.text.value)))
        };
      },

      /* ---- faixas ---- */
      addTrack(kind, name, index) {
        return tx('track', () => {
          const t = { id: newId('t'), kind: kind === 'audio' ? 'audio' : 'video', name: name || (kind === 'audio' ? 'Áudio ' : 'Vídeo ') + (P.tracks.filter(x => x.kind === (kind === 'audio' ? 'audio' : 'video')).length + 1), mute: false, solo: false, locked: false, clips: [] };
          if (index == null || index < 0 || index > P.tracks.length) P.tracks.push(t); else P.tracks.splice(index, 0, t);
          return t.id;
        });
      },
      removeTrack(id) { tx('track', () => { P.tracks = P.tracks.filter(t => t.id !== id); }); },
      setTrack(id, props) { tx('track', () => { const t = findTrack(id); if (!t) fail('Faixa não encontrada.'); for (const k of ['name', 'mute', 'solo', 'locked', 'volume', 'pan', 'bus']) if (k in props) t[k] = props[k]; }); },
      moveTrack(id, index) { tx('track', () => { const i = P.tracks.findIndex(t => t.id === id); if (i < 0) fail('Faixa não encontrada.'); const [t] = P.tracks.splice(i, 1); P.tracks.splice(clamp(index, 0, P.tracks.length), 0, t); }); },

      /* ---- clipes ---- */
      addClip(trackId, clip) {
        return tx('add', () => {
          const t = findTrack(trackId); if (!t) fail('Faixa não encontrada.');
          if (t.locked) fail('Faixa bloqueada.');
          const c = norm(clone(clip));
          if (c.type !== 'text' && c.type !== 'shape' && c.type !== 'adjust' && c.asset && !P.assets[c.asset]) fail('Mídia desconhecida: ' + c.asset);
          t.clips.push(c); return c.id;
        });
      },
      /** Insere no fim da faixa. */
      append(trackId, clip) { const t = findTrack(trackId); if (!t) fail('Faixa não encontrada.'); let e = 0; for (const c of t.clips) e = Math.max(e, clipEnd(c)); return T.addClip(trackId, Object.assign({}, clip, { start: e })); },
      get(id) { return find(id).clip; },
      set(id, props) { tx('set', () => { const { clip } = find(id); Object.assign(clip, clone(props)); norm(clip); }); },
      remove(id) { tx('remove', () => { const { track, clip } = find(id); track.clips = track.clips.filter(c => c !== clip); }); },
      /** Razor: divide o clipe no tempo t (da linha do tempo). Devolve o id do clipe novo (parte direita). */
      split(id, t) {
        return tx('split', () => {
          const { track, clip } = find(id);
          if (t <= clip.start + EPS || t >= clipEnd(clip) - EPS) fail('Ponto de corte fora do clipe.');
          const left = t - clip.start;
          const right = clone(clip); right.id = newId('c'); right.start = t; right.dur = clip.dur - left;
          if (clip.type === 'video' || clip.type === 'audio') {
            if (clip.reverse) { const total = rampIntegral(clip, clip.dur), il = rampIntegral(clip, left); right.in = clip.in; clip.in = clip.in + total - il; }
            else right.in = srcTime(clip, left);
          }
          if (clip.keys) { for (const p of Object.keys(clip.keys)) right.keys[p] = clip.keys[p].map(k => ({ ...k, t: k.t - left })); }
          if (clip.ramp) right.ramp = clip.ramp.map(r => ({ ...r, t: r.t - left }));
          clip.dur = left;
          if (right.transitionIn) delete right.transitionIn;
          track.clips.push(right); return right.id;
        });
      },
      /** Corta todas as faixas (ou as indicadas) no tempo t. */
      razor(t, trackIds) {
        return tx('razor', () => {
          const ids = [];
          for (const tr of P.tracks) {
            if (trackIds && !trackIds.includes(tr.id)) continue;
            if (tr.locked) continue;
            for (const c of tr.clips.slice()) if (t > c.start + EPS && t < clipEnd(c) - EPS) ids.push(T.split(c.id, t));
          }
          return ids;
        });
      },
      /** Trim de borda: edge 'start' ou 'end', para o tempo `to` da linha do tempo. */
      trim(id, edge, to) {
        tx('trim', () => {
          const { clip } = find(id), isMedia = clip.type === 'video' || clip.type === 'audio';
          if (edge === 'end') {
            const nd = Math.max(EPS, to - clip.start);
            if (isMedia && clip.reverse) clip.in = (clip.in || 0) + rampIntegral(clip, clip.dur) - rampIntegral(clip, nd);
            clip.dur = nd; return;
          }
          const nStart = clamp(to, 0, clipEnd(clip) - EPS), d = nStart - clip.start;
          if (isMedia && !clip.reverse) clip.in = Math.max(0, (clip.in || 0) + (d >= 0 ? rampIntegral(clip, d) : d * (clip.speed || 1)));
          if (clip.keys) for (const p of Object.keys(clip.keys)) clip.keys[p] = clip.keys[p].map(k => ({ ...k, t: k.t - d }));
          if (clip.ramp) clip.ramp = clip.ramp.map(r => ({ ...r, t: r.t - d }));
          clip.start = nStart; clip.dur -= d;
        });
      },
      /** Apaga e fecha o buraco (ripple): desloca o que vem depois na mesma faixa (ou em todas). */
      rippleDelete(id, allTracks) {
        tx('ripple', () => {
          const { track, clip } = find(id), s = clip.start, d = clip.dur;
          track.clips = track.clips.filter(c => c !== clip);
          for (const tr of allTracks ? P.tracks : [track]) for (const c of tr.clips) if (c.start >= s + d - EPS) c.start = Math.max(0, c.start - d);
        });
      },
      /** Remove o trecho [t0,t1] das faixas e fecha o buraco. Base da edição por texto. */
      cutRanges(ranges, trackIds) {
        tx('cut', () => {
          const rs = ranges.map(r => [Math.min(r[0], r[1]), Math.max(r[0], r[1])]).filter(r => r[1] - r[0] > EPS).sort((a, b) => b[0] - a[0]);
          for (const [a, b] of rs) {
            for (const tr of P.tracks) {
              if (trackIds && !trackIds.includes(tr.id)) continue;
              if (tr.locked) continue;
              for (const c of tr.clips.slice()) {
                if (a > c.start + EPS && a < clipEnd(c) - EPS) T.split(c.id, a);
              }
              for (const c of tr.clips.slice()) {
                if (b > c.start + EPS && b < clipEnd(c) - EPS) T.split(c.id, b);
              }
              tr.clips = tr.clips.filter(c => !(c.start >= a - EPS && clipEnd(c) <= b + EPS));
              for (const c of tr.clips) if (c.start >= b - EPS) c.start -= (b - a);
            }
          }
        });
      },
      /** Slip: muda o trecho da mídia mostrado, sem mover o clipe. */
      slip(id, delta) { tx('slip', () => { const { clip } = find(id); clip.in = Math.max(0, (clip.in || 0) + delta); }); },
      /** Slide: move o clipe e compensa os vizinhos da mesma faixa (o total não muda). */
      slide(id, delta) {
        tx('slide', () => {
          const { track, clip } = find(id), list = sortedClips(track), i = list.indexOf(clip), prev = list[i - 1], next = list[i + 1];
          if (prev && Math.abs(clipEnd(prev) - clip.start) < 1e-3 && next && Math.abs(clipEnd(clip) - next.start) < 1e-3) {
            const d = clamp(delta, -(prev.dur - 0.04), next.dur - 0.04);
            prev.dur += d; clip.start += d; next.start += d; next.dur -= d; next.in = (next.in || 0) + d * (next.speed || 1);
          } else clip.start = Math.max(0, clip.start + delta);
        });
      },
      move(id, start, trackId) {
        tx('move', () => {
          const f = find(id); f.clip.start = Math.max(0, start);
          if (trackId && trackId !== f.track.id) { const to = findTrack(trackId); if (!to) fail('Faixa não encontrada.'); if (to.locked) fail('Faixa bloqueada.'); f.track.clips = f.track.clips.filter(c => c !== f.clip); to.clips.push(f.clip); }
        });
      },
      duplicate(id) { return tx('dup', () => { const { track, clip } = find(id), c = clone(clip); c.id = newId('c'); c.start = clipEnd(clip); track.clips.push(c); return c.id; }); },
      /** Velocidade constante e reverso (altera a duração para consumir o mesmo trecho da mídia). */
      setSpeed(id, speed, reverse) {
        tx('speed', () => {
          const { clip } = find(id), span = srcSpan(clip), sp = clamp(num(speed, 1), 0.05, 100);
          clip.speed = sp; delete clip.ramp; clip.dur = Math.max(EPS, span / sp);
          if (reverse != null) clip.reverse = !!reverse;
        });
      },
      setKey(id, prop, t, v, opts) {
        tx('key', () => {
          const { clip } = find(id); clip.keys = clip.keys || {}; const arr = clip.keys[prop] = clip.keys[prop] || [];
          const k = Object.assign({ t, v }, opts || {}), i = arr.findIndex(x => Math.abs(x.t - t) < EPS);
          if (i >= 0) arr[i] = k; else arr.push(k);
          arr.sort((a, b) => a.t - b.t);
        });
      },
      removeKey(id, prop, t) { tx('key', () => { const { clip } = find(id), arr = clip.keys && clip.keys[prop]; if (arr) clip.keys[prop] = arr.filter(k => Math.abs(k.t - t) >= EPS); }); },

      /* ---- marcadores ---- */
      addMarker(t, name, color) { return tx('marker', () => { const m = { id: newId('m'), t: Math.max(0, t), name: name || '', color: color || 'accent' }; P.markers.push(m); P.markers.sort((a, b) => a.t - b.t); return m.id; }); },
      removeMarker(id) { tx('marker', () => { P.markers = P.markers.filter(m => m.id !== id); }); },

      /* ---- consultas ---- */
      clipsAt(t) {
        const out = [];
        P.tracks.forEach((tr, ti) => { for (const c of tr.clips) if (t >= c.start - EPS && t < clipEnd(c) - EPS) out.push({ clip: c, track: tr, index: ti }); });
        return out;
      },
      /** Pontos de encaixe (bordas de clipes, marcadores) para a interface. */
      snapPoints() { const s = new Set([0]); for (const t of P.tracks) for (const c of t.clips) { s.add(c.start); s.add(clipEnd(c)); } for (const m of P.markers) s.add(m.t); return Array.from(s).sort((a, b) => a - b); },
      toJSON() { return { version: 1, width: P.width, height: P.height, fps: P.fps, background: P.background, bins: clone(P.bins), tracks: clone(P.tracks), markers: clone(P.markers), assets: Object.fromEntries(Object.entries(P.assets).map(([k, a]) => [k, { id: a.id, kind: a.kind, name: a.name, duration: a.duration, width: a.width, height: a.height, tags: a.tags || [] }])) }; },

      /* ---- legendas / transcrição ---- */
      /** Cria clipes de texto a partir de cues (parseSubs) numa faixa de vídeo nova (ou na indicada). */
      addSubtitles(cues, opts) {
        opts = opts || {};
        return tx('subs', () => {
          const tid = opts.trackId || T.addTrack('video', 'Legendas');
          for (const c of cues) T.addClip(tid, { type: 'text', name: c.text.slice(0, 24), start: c.start, dur: c.end - c.start, text: Object.assign({ value: c.text, size: 0.055, color: '#ffffff', bg: 'rgba(0,0,0,0.6)', align: 'center', weight: 700 }, opts.style || {}), transform: { x: 0.5, y: 0.9 } });
          return tid;
        });
      },
      /** Cues a partir dos clipes de texto (ordenados). */
      subtitles(trackId) {
        const tr = trackId ? [findTrack(trackId)] : P.tracks;
        return tr.flatMap(t => t.clips.filter(c => c.type === 'text')).sort((a, b) => a.start - b.start).map(c => ({ start: c.start, end: clipEnd(c), text: c.text.value }));
      },
      toEDL(title) { return toEDL(P, title); },
      toXML(title) { return toXML(P, title); }
    };
    return T;
  }

  /* ---- EDL CMX3600 (uma faixa de vídeo, cortes secos; faixas de áudio em linhas A) ---- */
  function reelName(a, n) { return String((a && a.name) || 'CLIP' + n).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8).padEnd(8, ' '); }
  function toEDL(P, title) {
    const fps = P.fps, out = ['TITLE: ' + String(title || 'Projeto').replace(/[\r\n]/g, ' '), 'FCM: NON-DROP FRAME', ''];
    let n = 0;
    for (const tr of P.tracks) {
      if (tr.kind !== 'video' && tr.kind !== 'audio') continue;
      for (const c of sortedClips(tr)) {
        if (c.type !== 'video' && c.type !== 'audio') continue;
        const a = P.assets[c.asset], si = c.in || 0, so = si + srcSpan(c);
        out.push(String(++n).padStart(3, '0') + '  ' + reelName(a, n) + ' ' + (tr.kind === 'audio' ? 'A     ' : 'V     ') + 'C        ' + tc(si, fps) + ' ' + tc(so, fps) + ' ' + tc(c.start, fps) + ' ' + tc(clipEnd(c), fps));
        out.push('* FROM CLIP NAME: ' + ((a && a.name) || c.name || c.asset || ''));
        if (c.speed && c.speed !== 1) out.push('M2   ' + reelName(a, n) + '  ' + (c.speed * fps).toFixed(1) + '  ' + tc(si, fps));
      }
    }
    return out.join('\n') + '\n';
  }
  /** Lê EDL CMX3600 (cortes). Devolve {title, events:[{reel, name, track, srcIn, srcOut, recIn, recOut}]}. */
  function fromEDL(text, fps) {
    fps = fps || 30; const events = []; let title = '', last = null;
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const l = raw.trim();
      if (/^TITLE:/i.test(l)) { title = l.slice(6).trim(); continue; }
      const m = /^(\d{3,})\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:\S+\s+)?(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)/.exec(l);
      if (m) { last = { reel: m[2], track: /^A/i.test(m[3]) ? 'audio' : 'video', name: m[2], srcIn: parseTC(m[5], fps), srcOut: parseTC(m[6], fps), recIn: parseTC(m[7], fps), recOut: parseTC(m[8], fps) }; events.push(last); continue; }
      const nm = /^\*\s*FROM CLIP NAME:\s*(.+)$/i.exec(l);
      if (nm && last) last.name = nm[1].trim();
    }
    return { title, events };
  }
  /** Monta um projeto a partir de eventos de EDL. `findAsset(name)` devolve o id da mídia ou null. */
  function projectFromEDL(edl, opts, findAsset) {
    const T = create(opts), vt = T.addTrack('video', 'V1'), at = T.addTrack('audio', 'A1');
    for (const e of edl.events) {
      const asset = findAsset ? findAsset(e.name, e) : null; if (!asset) continue;
      const dur = e.recOut - e.recIn, sp = dur > 0 ? (e.srcOut - e.srcIn) / dur : 1;
      T.addClip(e.track === 'audio' ? at : vt, { type: e.track, asset, start: e.recIn, dur, in: e.srcIn, speed: sp > 0 ? sp : 1 });
    }
    return T;
  }

  function toXML(P, title) {
    const fps = Math.round(P.fps), x = [];
    x.push('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>', '<xmeml version="5">', '<sequence>', '<name>' + xmlEsc(title || 'Projeto') + '</name>');
    let d = 0; for (const t of P.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
    x.push('<duration>' + Math.round(d * fps) + '</duration>', '<rate><timebase>' + fps + '</timebase><ntsc>FALSE</ntsc></rate>', '<media>');
    x.push('<video><format><samplecharacteristics><width>' + P.width + '</width><height>' + P.height + '</height></samplecharacteristics></format>');
    for (const tr of P.tracks.filter(t => t.kind === 'video')) {
      x.push('<track>');
      for (const c of sortedClips(tr)) {
        if (c.type !== 'video' && c.type !== 'image') continue;
        const a = P.assets[c.asset] || {};
        x.push('<clipitem id="' + xmlEsc(c.id) + '"><name>' + xmlEsc(a.name || c.name || '') + '</name><start>' + Math.round(c.start * fps) + '</start><end>' + Math.round(clipEnd(c) * fps) + '</end><in>' + Math.round((c.in || 0) * fps) + '</in><out>' + Math.round(((c.in || 0) + srcSpan(c)) * fps) + '</out>' +
          '<file id="' + xmlEsc(c.asset || '') + '"><name>' + xmlEsc(a.name || '') + '</name></file></clipitem>');
      }
      x.push('</track>');
    }
    x.push('</video><audio>');
    for (const tr of P.tracks.filter(t => t.kind === 'audio')) {
      x.push('<track>');
      for (const c of sortedClips(tr)) {
        if (c.type !== 'audio') continue;
        const a = P.assets[c.asset] || {};
        x.push('<clipitem id="' + xmlEsc(c.id) + '"><name>' + xmlEsc(a.name || '') + '</name><start>' + Math.round(c.start * fps) + '</start><end>' + Math.round(clipEnd(c) * fps) + '</end><in>' + Math.round((c.in || 0) * fps) + '</in><out>' + Math.round(((c.in || 0) + srcSpan(c)) * fps) + '</out>' +
          '<file id="' + xmlEsc(c.asset || '') + '"><name>' + xmlEsc(a.name || '') + '</name></file></clipitem>');
      }
      x.push('</track>');
    }
    x.push('</audio></media>');
    if (P.markers.length) for (const m of P.markers) x.push('<marker><name>' + xmlEsc(m.name) + '</name><in>' + Math.round(m.t * fps) + '</in><out>-1</out></marker>');
    x.push('</sequence>', '</xmeml>');
    return x.join('\n');
  }
  /** Lê FCP XML (xmeml). Devolve {width, height, fps, clips:[{kind, name, start, dur, in, out(s)}], markers}. */
  function fromXML(text) {
    const root = parseXML(String(text)), seq = root.name === 'sequence' ? root : (function f(n) { if (n.name === 'sequence') return n; for (const c of n.children) { const r = f(c); if (r) return r; } return null; })(root);
    if (!seq) fail('XML sem sequência (esperado FCP XML/xmeml).');
    const fps = num(+ktext(kid(seq, 'rate'), 'timebase', 30), 30), out = { name: ktext(seq, 'name', ''), fps, width: 1280, height: 720, clips: [], markers: [] };
    const media = kid(seq, 'media');
    const walk = (n, f) => { f(n); for (const c of n.children) walk(c, f); };
    walk(seq, n => { if (n.name === 'width') out.width = +n.text || out.width; if (n.name === 'height') out.height = +n.text || out.height; });
    for (const kind of ['video', 'audio']) {
      const sec = media && kid(media, kind); if (!sec) continue;
      kids(sec, 'track').forEach((tr, ti) => {
        for (const ci of kids(tr, 'clipitem')) {
          const s = +ktext(ci, 'start', 0), e = +ktext(ci, 'end', 0), i = +ktext(ci, 'in', 0);
          if (!(e > s)) continue;
          const f = kid(ci, 'file');
          out.clips.push({ kind, track: ti, name: ktext(ci, 'name', '') || ktext(f, 'name', ''), start: s / fps, dur: (e - s) / fps, in: i / fps, file: f ? (f.attrs.id || '') : '' });
        }
      });
    }
    for (const m of kids(seq, 'marker')) out.markers.push({ t: +ktext(m, 'in', 0) / fps, name: ktext(m, 'name', '') });
    return out;
  }

  const api = {
    create, ease: EASE, bezier, track, value, srcTime, srcSpan, rampSpeed, tc, parseTC,
    parseSubs, toSRT, toVTT, toEDL, fromEDL, projectFromEDL, toXML, fromXML, parseXML, newId, clipEnd
  };

  /* ================= leitura de quadros (WebCodecs) ================= */
  const hasDOM = typeof document !== 'undefined' || typeof OffscreenCanvas === 'function';
  const mkCanvas = (w, h) => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const D = () => (R4 && R4.demux) || fail('R4.demux não carregado.');
  const tick = () => new Promise(r => setTimeout(r, 0));

  /**
   * Leitor de quadros com acesso aleatório sobre um arquivo já aberto pelo R4.demux.parse.
   * get(t) devolve o VideoFrame de apresentação em t (s); o quadro vale até a próxima chamada (não feche).
   * Para frente decodifica em sequência; para trás decodifica o GOP inteiro e guarda (reverso rápido).
   */
  function Reader(p, o) {
    o = o || {};
    const vt = p.tracks.find(t => t.kind === 'video'); if (!vt) fail('O arquivo não tem vídeo.');
    if (typeof VideoDecoder !== 'function') fail('Este navegador não decodifica vídeo (WebCodecs).', 'unsupported');
    const pk = vt.packets, MAXCACHE = o.cache || 150;
    const order = pk.map((x, i) => i).sort((a, b) => pk[a].timeUs - pk[b].timeUs);
    const ptsList = order.map(i => pk[i].timeUs);
    const cfg = { codec: vt.codec, codedWidth: vt.width, codedHeight: vt.height };
    if (vt.description) cfg.description = vt.description;
    const cache = new Map(); let dec = null, fed = -1, lowFed = 0, err = null, lastT = -1, closed = false;
    const AHEAD = o.ahead == null ? 10 : o.ahead;
    const keyBefore = i => { while (i > 0 && !pk[i].key) i--; return i; };
    const nextKey = i => { i++; while (i < pk.length && !pk[i].key) i++; return i; };
    function reset() {
      for (const f of cache.values()) f.close(); cache.clear();
      if (dec) { try { dec.close(); } catch (e) { /* já fechado */ } }
      dec = new VideoDecoder({ output: f => { if (closed) { f.close(); return; } const old = cache.get(f.timestamp); if (old) old.close(); cache.set(f.timestamp, f); }, error: e => { err = e; } });
      dec.configure(cfg); fed = -1; err = null;
    }
    function evict(keep) {
      if (cache.size <= MAXCACHE) return;
      const keys = Array.from(cache.keys()).sort((a, b) => Math.abs(a - keep) - Math.abs(b - keep));
      for (const k of keys.slice(MAXCACHE)) { cache.get(k).close(); cache.delete(k); }
    }
    const idxAt = tUs => { let lo = 0, hi = ptsList.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (ptsList[m] <= tUs + 500) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
    async function waitFor(ts, tries) {
      for (let i = 0; i < tries && !cache.has(ts) && !err; i++) await tick();
      return cache.has(ts);
    }
    const self = {
      width: vt.width, height: vt.height, duration: p.duration, frames: pk.length,
      /** Índice de apresentação e tempos vizinhos para mistura de quadros. */
      around(t) { const i = idxAt(Math.max(0, t) * 1e6), j = Math.min(i + 1, ptsList.length - 1); return { a: ptsList[i] / 1e6, b: ptsList[j] / 1e6 }; },
      async get(t) {
        if (closed) fail('Leitor fechado.');
        const tUs = Math.max(0, t) * 1e6, pi = idxAt(tUs), ts = ptsList[pi], di = order[pi], backwards = lastT >= 0 && tUs < lastT - 1;
        lastT = tUs;
        if (cache.has(ts)) return cache.get(ts);
        const k = keyBefore(di);
        const cont = dec && fed >= k - 1 && fed >= lowFed - 1 && fed < di, pending = dec && !cont && lowFed <= di && fed >= di && fed - di <= AHEAD + 4;
        if (!cont && !pending) { reset(); fed = k - 1; lowFed = k; }
        const stop = backwards ? Math.min(nextKey(k) - 1, k + MAXCACHE - 1) : Math.min(di + 6, pk.length - 1);
        while (fed < stop && !err) {
          fed++; dec.decode(D().toChunk(pk[fed], 'video'));
          if (dec.decodeQueueSize > 8) await tick();
          if (fed >= di && cache.has(ts) && !backwards) break;
        }
        if (!err && !(await waitFor(ts, 40))) { try { await dec.flush(); } catch (e) { /* tratado abaixo */ } fed = -1; dec = null; }
        if (err) fail('Falha ao decodificar o vídeo: ' + err.message, 'decode');
        if (!cache.has(ts)) { const near = Array.from(cache.keys()).sort((a, b) => Math.abs(a - ts) - Math.abs(b - ts))[0]; if (near == null) fail('Quadro não decodificado.', 'decode'); evict(ts); return cache.get(near); }
        evict(ts);
        if (!backwards && dec && !err) { const lim = Math.min(di + AHEAD, pk.length - 1); while (fed < lim && dec.decodeQueueSize < 4) { fed++; dec.decode(D().toChunk(pk[fed], 'video')); } }
        return cache.get(ts);
      },
      close() { closed = true; for (const f of cache.values()) f.close(); cache.clear(); if (dec) { try { dec.close(); } catch (e) { /* ok */ } } dec = null; }
    };
    return self;
  }

  /* ================= fontes (mídias abertas) ================= */
  const bytesOf = async s => {
    if (s instanceof Uint8Array) return s; if (s instanceof ArrayBuffer) return new Uint8Array(s);
    if (typeof Blob !== 'undefined' && s instanceof Blob) { if (s.size > 1024 * 1024 * 1024) fail('Arquivo grande demais (máximo 1 GB).'); return new Uint8Array(await s.arrayBuffer()); }
    return fail('Mídia sem arquivo (src): use File, Blob ou ArrayBuffer.');
  };
  /** Gerenciador de mídias de um projeto: abre vídeo/imagem sob demanda e guarda o leitor. */
  function sources(T, o) {
    o = o || {}; const P = T.project || T, readers = {}, images = {}, parsed = {}, audios = {};
    const pick = a => (o.proxy && a.proxy ? a.proxy : a.src);
    const parse = async a => (parsed[a.id] || (parsed[a.id] = bytesOf(pick(a)).then(b => { const d = D().parse(b); d.bytes = b; return d; })));
    return {
      async reader(id) { const a = P.assets[id]; if (!a) fail('Mídia desconhecida: ' + id); if (!readers[id]) readers[id] = Reader(await parse(a), o); return readers[id]; },
      async image(id) {
        const a = P.assets[id]; if (!a) fail('Mídia desconhecida: ' + id);
        if (!images[id]) images[id] = (async () => { const s = a.bitmap || pick(a); if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) return s; return createImageBitmap(s instanceof Blob ? s : new Blob([await bytesOf(s)])); })();
        return images[id];
      },
      async parsed(id) { const a = P.assets[id]; if (!a) fail('Mídia desconhecida: ' + id); return parse(a); },
      async audio(id, rate) {
        const a = P.assets[id]; if (!a) fail('Mídia desconhecida: ' + id);
        const k = id + '@' + rate; if (!audios[k]) audios[k] = (async () => (parsed[a.id] ? (await parsed[a.id].catch(() => null)) : null))().then(async d => R4.audio.decode(d ? d.bytes : await bytesOf(pick(a)), { sampleRate: rate })).catch(() => null);
        return audios[k];
      },
      close() { for (const r of Object.values(readers)) r.close(); for (const k of Object.keys(images)) images[k].then(b => b && b.close && b.close()).catch(() => 0); }
    };
  }

  /* ================= composição de quadro ================= */
  const BLEND = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', dodge: 'color-dodge', burn: 'color-burn', hardlight: 'hard-light', softlight: 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity', add: 'lighter' };
  const G = () => (R4 && R4.gfx) || fail('R4.gfx não carregado.');
  const imgData = (cx, w, h) => cx.getImageData(0, 0, w, h);
  const colorOf = (c, d) => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i.test(c) ? c : d);

  /** Valor de um parâmetro de efeito/máscara com keyframes ("fx0.radius", "mask.x"). */
  const param = (clip, key, base, lt) => track(clip.keys && clip.keys[key], lt, base);

  function applyEffects(clip, cx, w, h, lt) {
    const list = clip.effects || []; if (!list.length) return;
    let img = imgData(cx, w, h); const g = G();
    list.forEach((e, i) => {
      if (!e || e.off) return;
      const pv = (k, d) => param(clip, 'fx' + i + '.' + k, e[k] != null ? e[k] : d, lt);
      switch (e.type) {
        case 'chroma': g.chromaKey(img, { color: e.color || '#00ff00', tolerance: pv('tolerance', 0.3), softness: pv('softness', 0.1), spill: pv('spill', 0.5) }); break;
        case 'grade': g.grade(img, Object.assign({}, e, { exposure: pv('exposure', 0), contrast: pv('contrast', 1), saturation: pv('saturation', 1), temperature: pv('temperature', 0), tint: pv('tint', 0) })); break;
        case 'lut': if (e.lut) g.applyLUT(img, e.lut, pv('strength', 1)); break;
        case 'blur': g.blur(img, Math.round(pv('radius', 4) * w / 1280)); break;
        case 'sharpen': g.sharpen(img, pv('amount', 0.5)); break;
        case 'vignette': g.vignette(img, { amount: pv('amount', 0.5), size: pv('size', 0.5) }); break;
        case 'pixelate': g.pixelate(img, Math.max(1, Math.round(pv('size', 8) * w / 1280))); break;
        case 'grain': g.grain(img, pv('amount', 0.1), Math.floor(lt * 30)); break;
        case 'invert': g.invert(img); break;
        case 'gray': { const d = img.data; for (let k = 0; k < d.length; k += 4) { const y = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; d[k] = d[k + 1] = d[k + 2] = y; } break; }
        default: break;
      }
    });
    cx.putImageData(img, 0, 0);
  }

  /** Caminho/forma da máscara; devolve um canvas alfa (branco = visível). */
  function maskCanvas(clip, w, h, lt) {
    const m = clip.mask; if (!m) return null;
    const mc = mkCanvas(w, h), c = mc.getContext('2d'), pv = (k, d) => param(clip, 'mask.' + k, m[k] != null ? m[k] : d, lt);
    c.fillStyle = '#fff';
    c.beginPath();
    if (m.shape === 'ellipse') c.ellipse(pv('x', 0.5) * w, pv('y', 0.5) * h, pv('w', 0.5) * w / 2, pv('h', 0.5) * h / 2, 0, 0, Math.PI * 2);
    else if (m.shape === 'path' && Array.isArray(m.points) && m.points.length > 2) { m.points.forEach((p, i) => (i ? c.lineTo(p.x * w, p.y * h) : c.moveTo(p.x * w, p.y * h))); c.closePath(); }
    else c.rect((pv('x', 0.5) - pv('w', 0.5) / 2) * w, (pv('y', 0.5) - pv('h', 0.5) / 2) * h, pv('w', 0.5) * w, pv('h', 0.5) * h);
    c.fill();
    const f = pv('feather', 0) * Math.max(w, h);
    if (f > 0.5) {
      const img = c.getImageData(0, 0, w, h), a = G().blur(img, Math.max(1, Math.round(f)));
      c.putImageData(a, 0, 0);
    }
    return mc;
  }

  function wrapText(c, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = ''; for (const word of para.split(/\s+/)) { const t = line ? line + ' ' + word : word; if (line && c.measureText(t).width > maxW) { out.push(line); line = word; } else line = t; }
      out.push(line);
    }
    return out;
  }
  function drawText(c, clip, w, h, lt) {
    const tx = clip.text || {}, size = Math.max(4, (tx.size || 0.06) * h), anim = tx.anim || {}, ad = anim.dur || 0.5;
    let value = String(tx.value == null ? '' : tx.value), alpha = 1, dy = 0, sc = 1;
    if (anim.type === 'typewriter') value = value.slice(0, Math.floor(value.length * clamp(lt / Math.max(ad, 0.01), 0, 1)));
    else if (anim.type === 'fade') alpha = clamp(lt / Math.max(ad, 0.01), 0, 1);
    else if (anim.type === 'slideUp') { const p = EASE.out(clamp(lt / Math.max(ad, 0.01), 0, 1)); dy = (1 - p) * size * 1.5; alpha = p; }
    else if (anim.type === 'pop') { const p = EASE.back(clamp(lt / Math.max(ad, 0.01), 0, 1)); sc = p; alpha = clamp(lt / 0.1, 0, 1); }
    if (anim.out && clip.dur - lt < anim.out) alpha *= clamp((clip.dur - lt) / anim.out, 0, 1);
    c.save(); c.globalAlpha *= alpha; c.translate(0, dy); if (sc !== 1) c.scale(sc, sc);
    c.font = (tx.italic ? 'italic ' : '') + (tx.weight || 600) + ' ' + size + 'px ' + (tx.font ? '"' + String(tx.font).replace(/["\\]/g, '') + '", ' : '') + 'system-ui, sans-serif';
    c.textBaseline = 'middle'; c.textAlign = tx.align === 'left' ? 'left' : tx.align === 'right' ? 'right' : 'center';
    const lines = wrapText(c, value, (tx.maxWidth || 0.9) * w), lh = size * 1.25, total = lines.length * lh, pad = size * 0.35;
    const maxLine = Math.max.apply(null, lines.map(l => c.measureText(l).width).concat([1]));
    const ax = tx.align === 'left' ? -maxLine / 2 : tx.align === 'right' ? maxLine / 2 : 0;
    if (tx.lowerThird) {
      c.fillStyle = colorOf(tx.barColor, 'rgba(0,0,0,0.65)'); c.fillRect(-maxLine / 2 - pad * 2, -total / 2 - pad, maxLine + pad * 4, total + pad * 2);
      c.fillStyle = colorOf(tx.accent, '#2f80ed'); c.fillRect(-maxLine / 2 - pad * 2, -total / 2 - pad, Math.max(3, size * 0.12), total + pad * 2);
    } else if (tx.bg) { c.fillStyle = colorOf(tx.bg, 'rgba(0,0,0,0.5)'); c.fillRect(-maxLine / 2 - pad, -total / 2 - pad * 0.5, maxLine + pad * 2, total + pad); }
    if (tx.shadow) { c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = size * 0.2; c.shadowOffsetY = size * 0.05; }
    lines.forEach((l, i) => {
      const y = -total / 2 + lh * (i + 0.5);
      if (tx.stroke) { c.lineWidth = tx.stroke * size; c.strokeStyle = colorOf(tx.strokeColor, '#000'); c.lineJoin = 'round'; c.strokeText(l, ax, y); }
      c.fillStyle = colorOf(tx.color, '#fff'); c.fillText(l, ax, y);
    });
    c.restore();
  }
  function drawShape(c, clip, w, h) {
    const s = clip.shape || {}, sw = (s.w == null ? 0.3 : s.w) * w, sh = (s.h == null ? 0.3 : s.h) * h;
    c.fillStyle = colorOf(s.fill, '#fff'); c.strokeStyle = colorOf(s.stroke, '#000'); c.lineWidth = (s.lineWidth || 0) * h;
    c.beginPath();
    if (s.kind === 'ellipse') c.ellipse(0, 0, sw / 2, sh / 2, 0, 0, Math.PI * 2);
    else if (s.kind === 'triangle') { c.moveTo(0, -sh / 2); c.lineTo(sw / 2, sh / 2); c.lineTo(-sw / 2, sh / 2); c.closePath(); }
    else if (s.kind === 'line') { c.moveTo(-sw / 2, 0); c.lineTo(sw / 2, 0); c.lineCap = 'round'; }
    else if (s.kind === 'arrow') { const a = Math.min(sh, sw * 0.3); c.moveTo(-sw / 2, 0); c.lineTo(sw / 2, 0); c.moveTo(sw / 2 - a, -a / 2); c.lineTo(sw / 2, 0); c.lineTo(sw / 2 - a, a / 2); c.lineCap = 'round'; c.lineJoin = 'round'; }
    else if (s.radius && c.roundRect) c.roundRect(-sw / 2, -sh / 2, sw, sh, s.radius * h);
    else c.rect(-sw / 2, -sh / 2, sw, sh);
    if (s.kind !== 'line' && s.kind !== 'arrow' && s.fill !== 'none') c.fill();
    if (c.lineWidth > 0 || s.kind === 'line' || s.kind === 'arrow') { if (!c.lineWidth) c.lineWidth = 0.01 * h; c.stroke(); }
  }

  function fitRect(sw, sh, w, h, fit) {
    const k = fit === 'cover' ? Math.max(w / sw, h / sh) : fit === 'fill' ? 0 : Math.min(w / sw, h / sh);
    return fit === 'fill' ? { w, h } : { w: sw * k, h: sh * k };
  }
  /** Desenha a mídia do clipe (com mistura de quadros em câmera lenta). Cada quadro é desenhado na hora. */
  async function drawMedia(c, clip, lt, w, h, src, opts) {
    let a;
    if (clip.type === 'image') a = await src.image(clip.asset);
    const stab = clip.stab && clip.stab.dx && clip.stab.dx.length ? clip.stab : null;
    const place = (img, iw, ih, alpha, ts) => {
      const r = fitRect(iw, ih, w, h, clip.fit || 'contain'); let z = 1, ox = 0, oy = 0;
      if (stab) { const i = clamp(Math.round(ts * (stab.fps || 30)), 0, stab.dx.length - 1); ox = stab.dx[i] * r.w; oy = stab.dy[i] * r.h; z = stab.zoom || 1.06; }
      if (alpha < 1) c.globalAlpha *= alpha;
      const cr = clip.crop;
      if (cr && cr.w > 0 && cr.h > 0) c.drawImage(img, cr.x * iw, cr.y * ih, cr.w * iw, cr.h * ih, (-r.w / 2 + cr.x * r.w) * z + ox, (-r.h / 2 + cr.y * r.h) * z + oy, r.w * cr.w * z, r.h * cr.h * z);
      else c.drawImage(img, -r.w / 2 + ox - (r.w * (z - 1)) / 2, -r.h / 2 + oy - (r.h * (z - 1)) / 2, r.w * z, r.h * z);
      if (alpha < 1) c.globalAlpha /= alpha;
    };
    if (clip.type === 'image') { place(a, a.width, a.height, 1, lt); return; }
    const rd = await src.reader(clip.asset), s = srcTime(clip, lt), speed = rampSpeed(clip, lt);
    const f1 = await rd.get(Math.min(s, Math.max(0, rd.duration - 1e-3)));
    place(f1, f1.displayWidth || rd.width, f1.displayHeight || rd.height, 1, lt);
    if (speed < 0.95 && opts.blendFrames !== false) {
      const ar = rd.around(s), span = ar.b - ar.a;
      if (span > 1e-4 && s > ar.a + 1e-3) {
        const mix = clamp((s - ar.a) / span, 0, 1), f2 = await rd.get(ar.b);
        if (f2 && f2 !== f1) place(f2, f2.displayWidth || rd.width, f2.displayHeight || rd.height, mix, lt);
      }
    }
  }

  function transitionState(clip, lt) {
    let p = 1, kind = null, tin = clip.transitionIn, tout = clip.transitionOut, dir = 'left';
    if (tin && tin.dur > 0 && lt < tin.dur) { p = EASE[tin.ease || 'sine'](clamp(lt / tin.dur, 0, 1)); kind = tin.type || 'crossfade'; dir = tin.dir || 'left'; }
    if (tout && tout.dur > 0 && clip.dur - lt < tout.dur) { const q = EASE[tout.ease || 'sine'](clamp((clip.dur - lt) / tout.dur, 0, 1)); if (q < p) { p = q; kind = tout.type || 'crossfade'; dir = tout.dir || 'left'; } }
    return { p, kind, dir };
  }

  /** Quanto o clipe precisa de camada própria (efeitos, máscara, transição que recorta). */
  const needsLayer = (clip, ts) => !!(clip.mask || (clip.effects && clip.effects.some(e => e && !e.off)) || (ts.kind === 'wipe') || clip.type === 'adjust');

  /**
   * Compõe o quadro do instante t (s) em ctx (w×h). `src` vem de sources(T). Assíncrono (decodifica vídeo).
   * Ordem: faixas de baixo para cima; dentro da faixa, por início. Faixas de áudio e silenciadas (video) não desenham.
   */
  async function compose(T, t, ctx, src, o) {
    o = o || {}; const P = T.project || T, w = o.w || P.width, h = o.h || P.height, solo = P.tracks.some(x => x.kind === 'video' && x.solo);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = colorOf(P.background, '#000'); ctx.fillRect(0, 0, w, h);
    for (const tr of P.tracks) {
      if (tr.kind !== 'video' || tr.hidden || (solo && !tr.solo)) continue;
      const clips = tr.clips.filter(c => t >= c.start - EPS && t < c.start + c.dur - EPS).sort((a, b) => a.start - b.start);
      for (const clip of clips) {
        if (clip.hidden) continue;
        const lt = t - clip.start, ts = transitionState(clip, lt);
        let alpha = value(clip, 'opacity', lt) * (ts.kind && ts.kind !== 'wipe' && ts.kind !== 'slide' && ts.kind !== 'fade' ? ts.p : 1);
        if (ts.kind === 'fade') alpha *= ts.p;
        if (alpha <= 0.001) continue;
        const layer = needsLayer(clip, ts);
        let target = ctx, lc = null, base = ctx;
        if (layer) { lc = mkCanvas(w, h); target = lc.getContext('2d'); }
        if (clip.type === 'adjust') {
          target.drawImage(ctx.canvas, 0, 0, w, h);
        } else {
          target.save();
          let x = value(clip, 'x', lt) * w, y = value(clip, 'y', lt) * h;
          const sc = value(clip, 'scale', lt), sx = sc * value(clip, 'scaleX', lt), sy = sc * value(clip, 'scaleY', lt);
          if (ts.kind === 'slide') { const k = 1 - ts.p; x += (ts.dir === 'right' ? 1 : ts.dir === 'left' ? -1 : 0) * k * w; y += (ts.dir === 'down' ? 1 : ts.dir === 'up' ? -1 : 0) * k * h; }
          target.translate(x, y); target.rotate(value(clip, 'rotation', lt) * Math.PI / 180);
          const zs = ts.kind === 'zoom' ? 0.5 + 0.5 * ts.p : 1;
          target.scale(sx * zs, sy * zs);
          if (clip.flipX) target.scale(-1, 1);
          if (!layer) { target.globalAlpha = alpha; target.globalCompositeOperation = BLEND[clip.blend] || 'source-over'; }
          if (clip.type === 'text') drawText(target, clip, w, h, lt);
          else if (clip.type === 'shape') drawShape(target, clip, w, h);
          else await drawMedia(target, clip, lt, w, h, src, o);
          target.restore();
        }
        if (layer) {
          const lcx = lc.getContext('2d');
          applyEffects(clip, lcx, w, h, lt);
          const m = clip.type === 'adjust' ? null : maskCanvas(clip, w, h, lt);
          if (clip.type === 'adjust' && clip.mask) { const mm = maskCanvas(clip, w, h, lt); lcx.globalCompositeOperation = clip.mask.invert ? 'destination-out' : 'destination-in'; lcx.drawImage(mm, 0, 0); lcx.globalCompositeOperation = 'source-over'; }
          if (m) { lcx.globalCompositeOperation = clip.mask.invert ? 'destination-out' : 'destination-in'; lcx.drawImage(m, 0, 0); lcx.globalCompositeOperation = 'source-over'; }
          base.save(); base.globalAlpha = alpha; base.globalCompositeOperation = BLEND[clip.blend] || 'source-over';
          if (ts.kind === 'wipe') { base.beginPath(); const q = ts.p; if (ts.dir === 'right') base.rect(w * (1 - q), 0, w * q, h); else if (ts.dir === 'down') base.rect(0, 0, w, h * q); else if (ts.dir === 'up') base.rect(0, h * (1 - q), w, h * q); else base.rect(0, 0, w * q, h); base.clip(); }
          base.drawImage(lc, 0, 0); base.restore();
        }
      }
    }
    ctx.restore();
  }

  /* ================= áudio do projeto ================= */
  const AU = () => (R4 && R4.audio) || (typeof require !== 'undefined' ? require('./audio.js') : fail('R4.audio não carregado.'));
  const DSP = () => (R4 && R4.dsp) || (typeof require !== 'undefined' ? require('./dsp.js') : fail('R4.dsp não carregado.'));

  /** Áudio de um clipe já com trecho, velocidade, reverso e fades aplicados. */
  async function clipAudio(clip, src, rate) {
    const A = AU(), asset = src.project.assets[clip.asset]; if (!asset) return null;
    let a = await src.audio(clip.asset, rate); if (!a) return null;
    const dur = a.channels[0].length / a.sampleRate, from = clip.in || 0, to = Math.min(dur, from + srcSpan(clip));
    if (to <= from) return null;
    a = A.trim(a, from, to);
    const sp = clip.speed || 1;
    if (clip.ramp && clip.ramp.length) { const target = clip.dur; a = A.speed(a, (to - from) / target); }
    else if (Math.abs(sp - 1) > 1e-3) a = sp >= 0.25 && sp <= 4 ? A.stretch(a, sp) : A.speed(a, sp);
    if (clip.reverse) a = A.reverse(a);
    if (clip.fadeIn || clip.fadeOut) a = A.fade(a, clip.fadeIn || 0, clip.fadeOut || 0);
    return a;
  }
  /**
   * Mixa o áudio do projeto (clipes de áudio e o som dos clipes de vídeo) com R4.dsp.mixdown.
   * Opções: rate (48000), lufs (alvo), limiter (dB), duck {voice:[ids de faixas], music:[ids], amount, threshold}, buses, returns, master, src.
   */
  async function mixAudio(T, o) {
    o = o || {}; const P = T.project, rate = o.rate || 48000, dsp = DSP(), src = o.src || sources(T, o), own = !o.src; src.project = P;
    const solo = P.tracks.some(t => t.solo), groups = { all: [], voice: [], music: [] };
    const dsel = o.duck || null;
    for (const tr of P.tracks) {
      if (tr.mute || (solo && !tr.solo)) continue;
      for (const clip of tr.clips) {
        if (clip.muted || (clip.type !== 'audio' && clip.type !== 'video') || !clip.asset) continue;
        if (clip.type === 'video' && clip.audio === false) continue;
        let a; try { a = await clipAudio(clip, src, rate); } catch (e) { a = null; }
        if (!a) continue;
        const keys = clip.keys && clip.keys.volume, auto = { mode: 'linear' };
        if (keys && keys.length) auto.gain = keys.map(k => ({ t: k.t, v: 20 * Math.log10(Math.max(k.v, 1e-4)) }));
        const m = { audio: a, offset: clip.start, gain: 20 * Math.log10(Math.max(1e-4, (clip.volume == null ? 1 : clip.volume) * (tr.volume == null ? 1 : tr.volume))), pan: (clip.pan || 0) + (tr.pan || 0), bus: tr.bus, fx: clip.fx, automation: keys && keys.length ? auto : undefined };
        const g = dsel && dsel.voice && dsel.voice.includes(tr.id) ? 'voice' : dsel && dsel.music && dsel.music.includes(tr.id) ? 'music' : 'all';
        groups[g].push(m);
      }
    }
    if (own) src.close();
    const mk = tracks => dsp.mixdown({ tracks, rate, duration: T.duration, buses: o.buses, returns: o.returns, master: groups.all.length || !dsel ? o.master : undefined });
    if (!groups.all.length && !groups.voice.length && !groups.music.length) return null;
    let out;
    if (dsel && (groups.voice.length || groups.music.length)) {
      const parts = [];
      const voice = groups.voice.length ? mk(groups.voice) : null; let music = groups.music.length ? mk(groups.music) : null;
      if (voice && music) music = dsp.duck(music, voice, { amount: dsel.amount, threshold: dsel.threshold, attack: dsel.attack, release: dsel.release });
      if (voice) parts.push({ audio: voice }); if (music) parts.push({ audio: music });
      if (groups.all.length) parts.push({ audio: mk(groups.all) });
      out = dsp.mixdown({ tracks: parts, rate, duration: T.duration, master: o.master });
    } else out = mk(groups.all);
    if (o.lufs != null) out = dsp.normalizeLUFS(out, o.lufs, o.ceiling == null ? -1 : o.ceiling);
    else if (o.limiter != null) out = dsp.limiter(out, { ceiling: o.limiter });
    return out;
  }

  /* ================= exportação ================= */
  const PRESETS = {
    youtube1080: { width: 1920, height: 1080, fps: 30, format: 'mp4', codec: 'h264' },
    youtube4k: { width: 3840, height: 2160, fps: 30, format: 'mp4', codec: 'h264' },
    shorts: { width: 1080, height: 1920, fps: 30, format: 'mp4', codec: 'h264' },
    instagram: { width: 1080, height: 1350, fps: 30, format: 'mp4', codec: 'h264' },
    web720: { width: 1280, height: 720, fps: 30, format: 'webm' },
    proxy: { width: 640, height: 360, fps: 24, bitrate: 900000, format: 'mp4' }
  };
  /**
   * Exporta o projeto como vídeo (mp4, mov, mkv, webm). Opções do R4.video.render + preset, audio (false), lufs, limiter, duck, range [de,até] (s).
   * Devolve { blob, info }.
   */
  async function exportVideo(T, o) {
    o = Object.assign({}, PRESETS[o && o.preset] || {}, o || {});
    const P = T.project, V = (R4 && R4.video) || fail('R4.video não carregado.');
    const range = Array.isArray(o.range) ? o.range : [0, T.duration], t0 = Math.max(0, range[0]), t1 = Math.min(T.duration, range[1]);
    if (!(t1 > t0)) fail('Projeto vazio: nada para exportar.');
    const fps = o.fps || P.fps, w = o.width || P.width, h = o.height || P.height;
    const src = sources(T, { proxy: !!o.proxy }); src.project = P;
    const ph = mkCanvas(w, h);
    let audioTrack = null;
    try {
      if (o.audio !== false) {
        const mix = await mixAudio(T, { src, rate: 48000, lufs: o.lufs, limiter: o.limiter, duck: o.duck, master: o.master, buses: o.buses, returns: o.returns });
        if (mix) audioTrack = t0 > 0 ? AU().trim(mix, t0, Math.min(t1, mix.channels[0].length / mix.sampleRate)) : mix;
      }
      const opts = Object.assign({}, o, { width: w, height: h, fps, audioTrack: audioTrack || undefined, audio: audioTrack ? true : false });
      delete opts.preset; delete opts.range; delete opts.proxy; delete opts.duck; delete opts.master; delete opts.buses; delete opts.returns; delete opts.lufs; delete opts.limiter;
      opts.draw = async (ctx, info) => { await compose(T, t0 + info.t, ctx, src, { w: info.w, h: info.h }); };
      return await V.concat([{ image: ph, seconds: t1 - t0 }], opts);
    } finally { src.close(); }
  }

  /** Um quadro do projeto como Blob de imagem. */
  async function snapshot(T, t, o) {
    o = o || {}; const P = T.project, w = o.width || P.width, h = o.height || Math.round(w * P.height / P.width), cv = mkCanvas(w, h), src = sources(T, o); src.project = P;
    try { await compose(T, t, cv.getContext('2d'), src, { w, h }); } finally { src.close(); }
    return cv.convertToBlob ? cv.convertToBlob({ type: o.type || 'image/png' }) : new Promise(r => cv.toBlob(r, o.type || 'image/png'));
  }

  /* ================= pré-visualização ================= */
  /**
   * Player: desenha o projeto no <canvas> dado. { play(), pause(), seek(t), time, playing, on('time'|'end'|'error'), destroy() }.
   * O áudio é mixado uma vez (e refeito quando o projeto muda) e tocado pelo WebAudio.
   */
  function player(T, canvas, o) {
    o = Object.assign({ audio: true, proxy: true }, o); const P = T.project;
    let src = sources(T, { proxy: o.proxy, cache: 40 }); src.project = P;
    let t = 0, playing = false, raf = 0, base = 0, startAt = 0, busy = false, dirty = true, actx = null, abuf = null, asrc = null, destroyed = false, wantT = null;
    const ls = {}, fire = (k, v) => (ls[k] || []).forEach(f => { try { f(v); } catch (e) { /* ouvinte */ } });
    const ctx = canvas.getContext('2d');
    const size = () => { const w = o.width || canvas.width || P.width, h = Math.round(w * P.height / P.width); if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h; return { w, h }; };
    const off = T.on(() => { dirty = true; abuf = null; });
    let back = null;
    async function draw(at) {
      if (busy) { wantT = at; return; }
      busy = true;
      try { const s = size(); if (!back || back.width !== s.w || back.height !== s.h) back = mkCanvas(s.w, s.h); await compose(T, at, back.getContext('2d'), src, { w: s.w, h: s.h }); if (!destroyed) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy'; ctx.drawImage(back, 0, 0); ctx.globalCompositeOperation = 'source-over'; } } catch (e) { fire('error', e); }
      busy = false; dirty = false;
      if (wantT != null && !destroyed) { const n = wantT; wantT = null; draw(n); }
    }
    async function prepAudio() {
      if (!o.audio || abuf || typeof AudioContext === 'undefined') return;
      const mix = await mixAudio(T, { rate: 44100, proxy: o.proxy }); if (!mix) return;
      actx = actx || new AudioContext(); abuf = actx.createBuffer(mix.channels.length, mix.channels[0].length, mix.sampleRate);
      mix.channels.forEach((c, i) => abuf.copyToChannel(c, i));
    }
    function stopAudio() { if (asrc) { try { asrc.stop(); } catch (e) { /* ok */ } asrc = null; } }
    function startAudio(from) { if (!abuf || !actx) return; stopAudio(); asrc = actx.createBufferSource(); asrc.buffer = abuf; asrc.connect(actx.destination); asrc.start(0, Math.max(0, from)); }
    function loop() {
      if (!playing || destroyed) return;
      t = base + (performance.now() - startAt) / 1000;
      if (t >= T.duration) { t = T.duration; self.pause(); fire('end', t); draw(Math.max(0, t - 0.001)); fire('time', t); return; }
      draw(t); fire('time', t); raf = requestAnimationFrame(loop);
    }
    const self = {
      get time() { return t; }, get playing() { return playing; },
      on(k, f) { (ls[k] = ls[k] || []).push(f); return self; },
      seek(x) { t = clamp(x, 0, Math.max(0, T.duration)); base = t; startAt = performance.now(); draw(t); fire('time', t); if (playing) startAudio(t); },
      refresh() { draw(t); },
      async play() { if (playing) return; if (t >= T.duration - 0.01) t = 0; try { await prepAudio(); } catch (e) { fire('error', e); } playing = true; base = t; startAt = performance.now(); startAudio(t); if (actx && actx.state === 'suspended') actx.resume(); raf = requestAnimationFrame(loop); fire('state', true); },
      pause() { if (!playing) return; playing = false; cancelAnimationFrame(raf); stopAudio(); fire('state', false); },
      destroy() { destroyed = true; self.pause(); off(); src.close(); if (actx) { try { actx.close(); } catch (e) { /* ok */ } } }
    };
    draw(0);
    return self;
  }

  /* ================= análise: estabilização e rastreamento ================= */
  async function grabGray(rd, t, w) {
    const f = await rd.get(t), k = w / (f.displayWidth || rd.width), h = Math.max(8, Math.round((f.displayHeight || rd.height) * k)), cv = mkCanvas(w, h), c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(f, 0, 0, w, h);
    return G().gray(c.getImageData(0, 0, w, h), 1);
  }
  /**
   * Estabiliza um clipe de vídeo: mede o movimento da câmera quadro a quadro, suaviza o caminho e guarda a correção em clip.stab
   * (fração do quadro por quadro, + zoom para cobrir as bordas). Opções: radius (quadros, 15), width (análise, 240), fps (análise, 15), zoom, signal, onProgress.
   */
  async function stabilize(T, clipId, o) {
    o = Object.assign({ radius: 15, width: 240, fps: 15 }, o); const clip = T.get(clipId);
    if (clip.type !== 'video') fail('Só clipes de vídeo podem ser estabilizados.');
    const src = sources(T); src.project = T.project;
    try {
      const rd = await src.reader(clip.asset), n = Math.max(2, Math.floor(clip.dur * o.fps)), path = []; let prev = await grabGray(rd, srcTime(clip, 0), o.width), ax = 0, ay = 0;
      path.push({ x: 0, y: 0 });
      for (let i = 1; i < n; i++) {
        if (o.signal && o.signal.aborted) fail('Cancelado.', 'abort');
        const cur = await grabGray(rd, srcTime(clip, i / o.fps), o.width), m = G().estimateMotion(prev, cur, {});
        ax += m.dx; ay += m.dy; path.push({ x: ax, y: ay }); prev = cur;
        if (o.onProgress) o.onProgress(i / n);
      }
      const corr = G().smoothPath(path, o.radius), W = prev.w, H = prev.h;
      const lim = o.maxShift || 0.08; corr.forEach(c => { c.x = clamp(c.x, -lim * W, lim * W); c.y = clamp(c.y, -lim * H, lim * H); });
      let mx = 0, my = 0; corr.forEach(c => { mx = Math.max(mx, Math.abs(c.x) / W); my = Math.max(my, Math.abs(c.y) / H); });
      const zoom = o.zoom || 1 + 2 * Math.max(mx, my) + 0.02;
      T.set(clipId, { stab: { fps: o.fps, dx: corr.map(c => c.x / W), dy: corr.map(c => c.y / H), zoom } });
      return { frames: n, zoom };
    } finally { src.close(); }
  }
  /**
   * Rastreia um ponto de um clipe de vídeo. `point` em fração do quadro {x,y} no início do clipe.
   * Devolve [{t, x, y, score}] (t local do clipe; x,y em fração do quadro).
   */
  async function trackClip(T, clipId, point, o) {
    o = Object.assign({ width: 320, fps: 15, block: 12, search: 20 }, o); const clip = T.get(clipId);
    const src = sources(T); src.project = T.project;
    try {
      const rd = await src.reader(clip.asset), n = Math.max(2, Math.floor(clip.dur * o.fps));
      let prev = await grabGray(rd, srcTime(clip, 0), o.width), pt = { x: point.x * prev.w, y: point.y * prev.h };
      const out = [{ t: 0, x: point.x, y: point.y, score: 1 }];
      for (let i = 1; i < n; i++) {
        if (o.signal && o.signal.aborted) fail('Cancelado.', 'abort');
        const cur = await grabGray(rd, srcTime(clip, i / o.fps), o.width), r = G().trackPoint(prev, cur, pt, { block: o.block, search: o.search });
        pt = { x: r.x, y: r.y }; out.push({ t: i / o.fps, x: pt.x / cur.w, y: pt.y / cur.h, score: r.score }); prev = cur;
        if (o.onProgress) o.onProgress(i / n);
      }
      return out;
    } finally { src.close(); }
  }
  /** Faz outro clipe (texto, forma, imagem) seguir o caminho rastreado. `from` = clipe rastreado (para alinhar à tela: tela = posição do clipe + (ponto-0,5)*escala). */
  function followTrack(T, targetId, path, o) {
    o = o || {}; const dx = o.offsetX || 0, dy = o.offsetY || 0;
    T.tx('follow', () => {
      for (const p of path) { T.setKey(targetId, 'x', p.t, p.x + dx, { ease: 'linear' }); T.setKey(targetId, 'y', p.t, p.y + dy, { ease: 'linear' }); }
    });
  }

  /* ================= multicam e edição por texto ================= */
  /**
   * Alinha clipes por áudio: `refId` fica onde está; cada `otherIds` é movido para casar o som (R4.dsp.syncOffset).
   * Devolve [{id, offset, confidence}].
   */
  async function syncClips(T, refId, otherIds, o) {
    o = o || {}; const P = T.project, src = sources(T); src.project = P; const ref = T.get(refId), rate = 16000, dsp = DSP();
    try {
      const ra = await src.audio(ref.asset, rate); if (!ra) fail('O clipe de referência não tem áudio.');
      const res = [];
      for (const id of otherIds) {
        const oc = T.get(id), oa = await src.audio(oc.asset, rate); if (!oa) { res.push({ id, offset: 0, confidence: 0 }); continue; }
        const r = dsp.syncOffset(ra, oa, { maxLag: o.maxLag || 30 });
        const start = Math.max(0, ref.start - (ref.in || 0) + r.offset + (oc.in || 0));
        T.tx('sync', () => T.move(id, start));
        res.push({ id, offset: r.offset, confidence: r.confidence });
      }
      return res;
    } finally { src.close(); }
  }
  /**
   * Corte multicâmera: `cams` = ids de clipes sobrepostos (um por faixa, já sincronizados); `cuts` = [{t, cam}] (índice em cams a partir de t).
   * Mantém em cada faixa só os trechos escolhidos.
   */
  function multicam(T, cams, cuts) {
    const list = cuts.slice().sort((a, b) => a.t - b.t); if (!list.length) fail('Sem cortes.');
    T.tx('multicam', () => {
      const tracks = cams.map(id => { const f = T.project.tracks.find(t => t.clips.some(c => c.id === id)); return f.id; });
      for (const c of list.slice(1)) T.razor(c.t, tracks);
      const segs = list.map((c, i) => ({ from: c.t, to: i + 1 < list.length ? list[i + 1].t : Infinity, cam: c.cam }));
      T.project.tracks.forEach(tr => {
        const idx = tracks.indexOf(tr.id); if (idx < 0) return;
        tr.clips = tr.clips.filter(clip => { const mid = clip.start + Math.min(clip.dur, 1e6) / 2, sg = segs.find(s => mid >= s.from && mid < s.to); return !sg || sg.cam === idx; });
      });
    });
  }
  /**
   * Edição por texto: `words` = [{start, end, word}] (de uma transcrição SRT/VTT/JSON importada);
   * `removed` = índices apagados. Remove os trechos correspondentes de todas as faixas (ripple).
   */
  function cutWords(T, words, removed) {
    const set = new Set(removed), ranges = []; let cur = null;
    words.forEach((w, i) => {
      if (set.has(i)) { if (cur && Math.abs(cur[1] - w.start) < 0.15) cur[1] = w.end; else { cur = [w.start, w.end]; ranges.push(cur); } } else cur = null;
    });
    T.cutRanges(ranges); return ranges;
  }
  /** Palavras estimadas a partir de cues (reparte o tempo de cada cue pelo tamanho das palavras). Para quando só há SRT/VTT. */
  function wordsFromCues(cues) {
    const out = [];
    for (const c of cues) { const ws = c.text.split(/\s+/).filter(Boolean), tot = ws.reduce((s, w) => s + w.length + 1, 0); let t = c.start; for (const w of ws) { const d = (c.end - c.start) * (w.length + 1) / tot; out.push({ start: t, end: t + d, word: w }); t += d; } }
    return out;
  }

  /* ================= proxies ================= */
  /** Gera uma cópia leve (proxy) do arquivo de vídeo e a guarda em asset.proxy. */
  async function makeProxy(T, assetId, o) {
    const a = T.project.assets[assetId]; if (!a || a.kind !== 'video') fail('Só mídias de vídeo têm proxy.');
    const V = (R4 && R4.video) || fail('R4.video não carregado.');
    const r = await V.transcode(a.src, Object.assign({ format: 'mp4', width: 640, fps: 24, bitrate: 900000, audio: false }, o));
    a.proxy = r.blob; return r.info;
  }

  /* ================= guardar e reabrir (IndexedDB) ================= */
  const DB = 'r4-timeline';
  function idb() {
    return new Promise((ok, no) => {
      if (typeof indexedDB === 'undefined') return no(new Error('IndexedDB indisponível.'));
      const q = indexedDB.open(DB, 1);
      q.onupgradeneeded = () => { const d = q.result; d.createObjectStore('projects', { keyPath: 'id' }); d.createObjectStore('versions', { keyPath: 'key' }); d.createObjectStore('assets', { keyPath: 'key' }); };
      q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
    });
  }
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const store = {
    /** Salva o projeto (JSON + arquivos das mídias) e uma versão no histórico (máx. 30). */
    async save(id, T, o) {
      o = o || {}; const d = await idb(), json = T.toJSON(), now = Date.now();
      try {
        const tx = d.transaction(['projects', 'versions', 'assets'], 'readwrite');
        tx.objectStore('projects').put({ id, name: o.name || id, time: now, json });
        const vs = tx.objectStore('versions'); vs.put({ key: id + '#' + now, id, time: now, json });
        const all = await req(vs.getAll()), mine = all.filter(v => v.id === id).sort((a, b) => b.time - a.time);
        mine.slice(30).forEach(v => vs.delete(v.key));
        for (const a of Object.values(T.project.assets)) if (a.src instanceof Blob || a.src instanceof ArrayBuffer) tx.objectStore('assets').put({ key: id + '/' + a.id, src: a.src, proxy: a.proxy || null });
        await new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error); });
      } finally { d.close(); }
      return now;
    },
    async list() { const d = await idb(); try { return (await req(d.transaction('projects').objectStore('projects').getAll())).map(p => ({ id: p.id, name: p.name, time: p.time })).sort((a, b) => b.time - a.time); } finally { d.close(); } },
    async history(id) { const d = await idb(); try { return (await req(d.transaction('versions').objectStore('versions').getAll())).filter(v => v.id === id).map(v => ({ key: v.key, time: v.time })).sort((a, b) => b.time - a.time); } finally { d.close(); } },
    /** Reabre um projeto (versão `key` do histórico, ou a mais recente). */
    async load(id, key) {
      const d = await idb();
      try {
        const rec = key ? await req(d.transaction('versions').objectStore('versions').get(key)) : await req(d.transaction('projects').objectStore('projects').get(id));
        if (!rec) fail('Projeto não encontrado.');
        const json = rec.json, assets = {};
        for (const [aid, a] of Object.entries(json.assets || {})) { const f = await req(d.transaction('assets').objectStore('assets').get(id + '/' + aid)); assets[aid] = Object.assign({}, a, f ? { src: f.src, proxy: f.proxy || undefined } : {}); }
        return create(Object.assign({}, json, { assets }));
      } finally { d.close(); }
    },
    async remove(id) {
      const d = await idb();
      try {
        const tx = d.transaction(['projects', 'versions', 'assets'], 'readwrite'); tx.objectStore('projects').delete(id);
        for (const s of ['versions', 'assets']) { const os = tx.objectStore(s); for (const r of await req(os.getAll())) if ((r.id || r.key.split('/')[0]) === id) os.delete(r.key); }
        await new Promise(ok => { tx.oncomplete = ok; tx.onerror = ok; });
      } finally { d.close(); }
    },
    /** Salva sozinho depois de cada edição (espera `wait` ms de sossego). Devolve a função que desliga. */
    auto(id, T, o) {
      o = Object.assign({ wait: 1500 }, o); let h = 0, busy = false, again = false;
      const run = async () => { if (busy) { again = true; return; } busy = true; try { const ts = await store.save(id, T, o); if (o.onSave) o.onSave(ts); } catch (e) { if (o.onError) o.onError(e); } busy = false; if (again) { again = false; run(); } };
      const off = T.on(() => { clearTimeout(h); h = setTimeout(run, o.wait); });
      return () => { clearTimeout(h); off(); };
    }
  };

  Object.assign(api, { Reader, sources, compose, mixAudio, exportVideo, snapshot, player, stabilize, trackClip, followTrack, syncClips, multicam, cutWords, wordsFromCues, makeProxy, store, PRESETS, BLEND });

  if (R4 && R4.module) R4.module('timeline', api, {
    title: 'R4.timeline', group: 'Mídia',
    description: 'Editor de vídeo multicamadas sem bibliotecas: projeto em JSON, faixas e clipes (vídeo, imagem, texto, forma, ajuste), razor/trim/ripple/slip/slide, keyframes com Bézier, velocidade e reverso, blend, máscaras, chroma key, efeitos, transições, legendas SRT/VTT, EDL e FCP XML, estabilização, rastreamento, multicam, proxies, autosave e exportação (MP4/MOV/MKV/WebM).',
    props: [
      { name: 'create({width, height, fps})', type: 'timeline', desc: 'Projeto com addTrack/addClip/split/razor/trim/rippleDelete/slip/slide/move/setSpeed/setKey/addMarker e undo/redo.' },
      { name: 'compose(T, t, ctx, sources(T))', type: 'Promise', desc: 'Desenha o quadro do instante t no canvas.' },
      { name: 'player(T, canvas)', type: '{play, pause, seek, on}', desc: 'Pré-visualização com áudio mixado.' },
      { name: 'exportVideo(T, {preset, format, codec, bitrate, lufs})', type: 'Promise<{blob, info}>', desc: 'Renderiza vídeo e áudio mixado.' },
      { name: 'parseSubs / toSRT / toVTT / toEDL / fromEDL / toXML / fromXML', type: 'intercâmbio', desc: 'Legendas e projetos para outros editores.' },
      { name: 'stabilize / trackClip / followTrack / syncClips / multicam / cutWords', type: 'análise', desc: 'Estabilização, rastreamento, sincronia por áudio, multicam e edição por texto.' },
      { name: 'store.save/load/list/history/auto', type: 'IndexedDB', desc: 'Salvar, reabrir e histórico de versões.' }
    ]
  });
  if (R4) {
    // R4.timeline é módulo (create, exportVideo...) e também atalho do componente de linha do tempo da UI: R4.timeline(el, itens, opts)
    const fn = function (target, a, b) {
      if (!R4.create) throw new Error('R4.timeline(): componente de interface não carregado.');
      const isEl = typeof target === 'string' || (target && target.nodeType === 1);
      const items = isEl ? a : target, extra = isEl ? b : a;
      const cfg = Object.assign({}, Array.isArray(items) ? { items } : items, extra, { xtype: 'timeline' });
      if (isEl) cfg.renderTo = target;
      return R4.create(cfg);
    };
    Object.assign(fn, api);
    R4.timeline = fn;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window.R4 : undefined);
