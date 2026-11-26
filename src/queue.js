/**
 * ============================================
 * libr4 / queue.js  —  R4 dev
 * ============================================
 * R4.queue: fila de tarefas pesadas (conversão, exportação, lote), sem bibliotecas.
 *   const q = R4.queue.create({ concurrency: 1 });
 *   q.add({ name, kind: 'convert'|'transcode'|'export'|'audio'|'custom', input, options, run(ctx) });
 *   q.on('progress'|'done'|'error'|'idle'|'change', fn);  q.pause() / q.resume() / q.cancel(id) / q.retry(id) / q.clear()
 *   q.batch(files, { kind, to, options })  → um job por arquivo
 *   q.watch({ filter, every, handler })     → "pasta monitorada" (File System Access API, Chrome/Edge em HTTPS, enquanto a página estiver aberta)
 * Cada job tem estado: waiting | running | done | error | canceled, progress 0..1 e result ({ blob, name, info }).
 * ============================================
 */
(function (R4) {
  'use strict';
  const fail = (m, code) => { const e = new Error(m); if (code) e.code = code; throw e; };
  let seq = 0;

  const KINDS = {
    convert: (j, ctx) => (R4.convert || fail('R4.convert não carregado.')).convert(j.input, j.to, Object.assign({}, j.options, { signal: ctx.signal, onProgress: ctx.progress })),
    transcode: (j, ctx) => R4.video.transcode(j.input, Object.assign({}, j.options, { signal: ctx.signal, onProgress: ctx.progress })),
    audio: async (j, ctx) => { const a = await R4.audio.decode(j.input); ctx.progress(0.5); const b = await R4.audio.encode(a, j.to || 'wav', j.options); ctx.progress(1); return { blob: b, name: 'audio.' + (j.to || 'wav') }; },
    export: (j, ctx) => R4.timeline.exportVideo(j.input, Object.assign({}, j.options, { signal: ctx.signal, onProgress: ctx.progress }))
  };

  function create(opts) {
    opts = Object.assign({ concurrency: 1, retries: 0 }, opts);
    const jobs = [], ls = {}; let running = 0, paused = false;
    const fire = (k, v) => (ls[k] || []).forEach(f => { try { f(v); } catch (e) { /* ouvinte */ } });
    const view = j => ({ id: j.id, name: j.name, kind: j.kind, state: j.state, progress: j.progress, error: j.error, result: j.result, tries: j.tries, time: j.time });
    function pump() {
      while (!paused && running < opts.concurrency) {
        const j = jobs.find(x => x.state === 'waiting'); if (!j) break;
        run(j);
      }
      if (!running && !jobs.some(x => x.state === 'waiting')) fire('idle', jobs.map(view));
    }
    async function run(j) {
      running++; j.state = 'running'; j.progress = 0; j.error = null; j.ctrl = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() { /* sem suporte */ } }; j.t0 = Date.now(); fire('change', view(j));
      const ctx = { signal: j.ctrl.signal, progress: p => { j.progress = Math.max(0, Math.min(1, p)); fire('progress', view(j)); } };
      try {
        const fn = j.run || KINDS[j.kind]; if (!fn) fail('Tipo de tarefa desconhecido: ' + j.kind);
        const r = await fn(j, ctx);
        if (j.state === 'canceled') throw Object.assign(new Error('Cancelado.'), { code: 'abort' });
        j.result = r; j.progress = 1; j.state = 'done'; j.time = Date.now() - j.t0; fire('done', view(j));
      } catch (e) {
        if (j.state === 'canceled' || (e && e.code === 'abort')) { j.state = 'canceled'; }
        else if (j.tries < opts.retries) { j.tries++; j.state = 'waiting'; }
        else { j.state = 'error'; j.error = (e && e.message) || String(e); fire('error', view(j)); }
      }
      running--; fire('change', view(j)); pump();
    }
    const q = {
      add(job) {
        if (!job || (!job.run && !KINDS[job.kind])) fail('Tarefa inválida: informe kind (' + Object.keys(KINDS).join(', ') + ') ou run().');
        const j = Object.assign({ id: 'q' + (++seq), name: 'Tarefa ' + seq, state: 'waiting', progress: 0, tries: 0, error: null, result: null }, job, { state: 'waiting' });
        jobs.push(j); fire('change', view(j)); setTimeout(pump, 0); return j.id;
      },
      batch(files, o) {
        o = o || {};
        return Array.from(files).map(f => q.add({ name: (o.prefix || '') + (f.name || 'arquivo'), kind: o.kind || 'convert', input: f, to: o.to, options: o.options, run: o.run && (j => o.run(j.input, j)) }));
      },
      get jobs() { return jobs.map(view); },
      get(id) { const j = jobs.find(x => x.id === id); return j ? view(j) : null; },
      get running() { return running; }, get paused() { return paused; },
      pause() { paused = true; fire('change', null); }, resume() { paused = false; fire('change', null); pump(); },
      cancel(id) { const j = jobs.find(x => x.id === id); if (!j) return false; if (j.state === 'running') { j.state = 'canceled'; j.ctrl.abort(); } else if (j.state === 'waiting') { j.state = 'canceled'; fire('change', view(j)); } return true; },
      retry(id) { const j = jobs.find(x => x.id === id); if (!j || (j.state !== 'error' && j.state !== 'canceled')) return false; j.state = 'waiting'; j.tries = 0; fire('change', view(j)); pump(); return true; },
      clear() { for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state !== 'running' && jobs[i].state !== 'waiting') jobs.splice(i, 1); fire('change', null); },
      on(k, f) { (ls[k] = ls[k] || []).push(f); return q; },
      /** Espera a fila esvaziar. */
      whenIdle() { return new Promise(ok => { if (!running && !jobs.some(x => x.state === 'waiting')) return ok(jobs.map(view)); const f = v => { ls.idle.splice(ls.idle.indexOf(f), 1); ok(v); }; (ls.idle = ls.idle || []).push(f); }); },
      /**
       * Pasta monitorada: pede uma pasta ao usuário e, a cada `every` ms, enfileira os arquivos novos que passam em `filter` (regex ou função).
       * Só funciona com a página aberta (e em Chrome/Edge, contexto seguro). Devolve { stop() }.
       */
      async watch(o) {
        o = Object.assign({ every: 3000, filter: /\.(mp4|mov|mkv|webm|wav|mp3|flac|png|jpe?g)$/i }, o);
        if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') fail('Pasta monitorada exige Chrome/Edge em HTTPS (File System Access API).', 'unsupported');
        const dir = o.dir || await window.showDirectoryPicker({ mode: 'read' }), seen = new Map();
        const ok = n => (typeof o.filter === 'function' ? o.filter(n) : o.filter.test(n));
        const scan = async first => {
          for await (const [name, h] of dir.entries()) {
            if (h.kind !== 'file' || !ok(name)) continue;
            const f = await h.getFile(), key = f.lastModified + ':' + f.size, prev = seen.get(name);
            if (prev === key) continue;
            if (prev === undefined && first && o.existing === false) { seen.set(name, key); continue; }
            if (prev !== undefined && prev !== key) { seen.set(name, key); continue; }   // ainda mudando: espera estabilizar
            seen.set(name, key);
            (o.handler ? o.handler(f, q) : q.add({ name, kind: o.kind || 'convert', input: f, to: o.to, options: o.options }));
          }
        };
        let stop = false, first = true;
        const loop = async () => { while (!stop) { try { await scan(first); } catch (e) { fire('error', { name: 'pasta', error: e.message }); } first = false; await new Promise(r => setTimeout(r, o.every)); } };
        loop();
        return { stop() { stop = true; } };
      }
    };
    return q;
  }

  /** Baixa o resultado de um job (Blob) pelo navegador. */
  function download(job, name) {
    const r = job && job.result; if (!r || !r.blob) fail('Tarefa sem resultado.');
    const a = document.createElement('a'), u = URL.createObjectURL(r.blob); a.href = u; a.download = name || r.name || 'resultado'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  const api = { create, download, kinds: () => Object.keys(KINDS) };
  if (R4 && R4.module) R4.module('queue', api, {
    title: 'R4.queue', group: 'Mídia',
    description: 'Fila de renderização e conversão em lote, com progresso, cancelamento, repetição e pasta monitorada (File System Access API).',
    props: [
      { name: 'create({concurrency, retries})', type: 'fila', desc: 'add, batch, pause, resume, cancel, retry, clear, on(progress|done|error|idle|change), whenIdle.' },
      { name: 'kind', type: "'convert' | 'transcode' | 'audio' | 'export' | run()", desc: 'Tarefas prontas ou função própria run(job, ctx).' },
      { name: 'watch({filter, every, handler})', type: 'Promise<{stop}>', desc: 'Enfileira arquivos novos de uma pasta escolhida, enquanto a página estiver aberta.' }
    ]
  });
  if (R4) R4.queue = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window.R4 : undefined);
