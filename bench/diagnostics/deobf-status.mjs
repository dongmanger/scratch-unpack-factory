import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const f = r.deobfuscation.factories;
const st = new Map();
for (const x of f) st.set(x.status, (st.get(x.status) || 0) + 1);
console.log('factories', f.length, Object.fromEntries(st));
const res = new Map();
for (const x of f) for (const q of x.residuals || []) {
  const k = (typeof q === 'string' ? q : (q.kind || q.reason || JSON.stringify(q))).toString().slice(0, 100);
  res.set(k, (res.get(k) || 0) + 1);
}
console.log('residual kinds', [...res].sort((a, b) => b[1] - a[1]).slice(0, 12));
const w = new Map();
for (const x of f) for (const q of x.warnings || []) {
  const k = String(q).slice(0, 100);
  w.set(k, (w.get(k) || 0) + 1);
}
console.log('warnings', [...w].sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log('example', JSON.stringify(f.find(x => x.status !== 'transformed') || f[0]).slice(0, 700));
