const JSZip = require('@turbowarp/jszip');
const fs = require('fs');

(async () => {
  const load = async p => {
    const zip = await JSZip.loadAsync(fs.readFileSync(p));
    return JSON.parse(await zip.file('project.json').async('text'));
  };
  const on = await load('out-beautify-on/recursive-strong.reconstructed.sb3');
  const off = await load('out-beautify-off/recursive-strong.reconstructed.sb3');
  const stripLayout = t => {
    const blocks = {};
    for (const [id, b] of Object.entries(t.blocks)) blocks[id] = {...b, x: undefined, y: undefined};
    return {blocks, variables: t.variables, lists: t.lists, broadcasts: t.broadcasts};
  };
  const same = on.targets.length === off.targets.length &&
    on.targets.every((t, i) => JSON.stringify(stripLayout(t)) === JSON.stringify(stripLayout(off.targets[i])));
  console.log('semantic skeleton identical (ignoring layout):', same);
  const layoutDiff = on.targets.some((t, i) => {
    const a = Object.entries(t.blocks).filter(([, b]) => b.topLevel).map(([id, b]) => id + ':' + b.x + ',' + b.y).sort();
    const c = Object.entries(off.targets[i].blocks).filter(([, b]) => b.topLevel).map(([id, b]) => id + ':' + b.x + ',' + b.y).sort();
    return JSON.stringify(a) !== JSON.stringify(c);
  });
  console.log('layout differs (grid applied):', layoutDiff);
  for (const [i, t] of on.targets.entries()) {
    const tops = Object.entries(t.blocks).filter(([, b]) => b.topLevel).map(([id, b]) => id + '@(' + b.x + ',' + b.y + ')');
    console.log('target', i, t.name, 'top blocks:', tops.join(' | '));
  }
  const rep = JSON.parse(fs.readFileSync('out-beautify-on/recursive-strong.fidelity-report.json', 'utf8'));
  console.log('beautify summary:', JSON.stringify(rep.code.beautify));
  // Check no double-not under boolean contexts in output blocks (CONDITION inputs)
  let doubleNotInConditions = 0;
  for (const t of on.targets) {
    for (const b of Object.values(t.blocks)) {
      const cond = b.inputs && b.inputs.CONDITION;
      if (cond && Array.isArray(cond) && cond[0] === 2) {
        const inner = t.blocks[cond[1]];
        if (inner && inner.opcode === 'operator_not') {
          const op = inner.inputs.OPERAND;
          if (op && Array.isArray(op) && op[0] === 2 && t.blocks[op[1]]?.opcode === 'operator_not') doubleNotInConditions++;
        }
      }
    }
  }
  console.log('double-not remaining in CONDITION inputs:', doubleNotInConditions);
})().catch(e => { console.error(e); process.exit(1); });
