// Ferramenta de manutencao (precisa de Node + playwright-core): recalcula src/deps.json.
// Dependencia = modulo citado como R4.<modulo> no fonte + modulo sem o qual o carregamento da lista falha.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
const src = path.resolve(process.argv[2] || 'src');
const loader = fs.readFileSync(path.join(src, 'libr4.js'), 'utf8');
const mods = [...loader.match(/\[\s*((?:'[\w-]+'\s*,?\s*)+)\]\s*\.forEach/)[1].matchAll(/'([\w-]+)'/g)].map(m => m[1]);
const code = Object.fromEntries(mods.map(m => [m, fs.readFileSync(path.join(src, m + '.js'), 'utf8')]));
const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
const page = await b.newPage();
await page.setContent('<body></body>');
const ok = async set => page.evaluate(async c => {
  const f = document.createElement('iframe'); document.body.appendChild(f);
  const w = f.contentWindow; let err = null; w.addEventListener('error', e => { err = err || e.message; });
  for (const s of c) { try { w.eval(s); } catch (e) { err = err || e.message; break; } if (err) break; }
  f.remove(); return !err;
}, set.map(m => code[m]));
const deps = {};
for (let i = 1; i < mods.length; i++) {
  const m = mods[i], before = mods.slice(0, i);
  const st = new Set(['core']);
  for (const o of before) if (new RegExp('\\bR4\\.' + o + '\\b').test(code[m])) st.add(o);
  let keep = before.filter(x => st.has(x));
  if (!(await ok([...keep, m].map(x => x)))) {
    keep = [...before];
    for (const o of before) {
      if (st.has(o)) continue;
      const t = keep.filter(x => x !== o);
      if (await ok([...t, m])) keep = t;
    }
  }
  deps[m] = keep;
}
fs.writeFileSync(path.join(src, 'deps.json'), JSON.stringify(deps, null, 1) + '\n');
console.log(JSON.stringify(deps));
await b.close();
