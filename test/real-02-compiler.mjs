import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';

const require = createRequire(import.meta.url);
const defaultRoot = fileURLToPath(new URL('../../research/02engine/scratch-vm/', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
export const actualVMRoot = () => path.resolve(process.env.FACTORY_02_VM_ROOT || defaultRoot);
export const actualVMClass = () => {
  const root = actualVMRoot();
  try { return require(path.join(root, 'src/index.js')); }
  catch (cause) { throw new Error(`Cannot load actual 02Engine VM at ${root}; install its real dependencies. ${cause.message}`, {cause}); }
};

export async function compileReal02(project, assets = {}) {
  const VM = actualVMClass();
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(project));
  for (const [name, data] of Object.entries(assets)) archive.file(name, data);
  const sb3 = await archive.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  const parsedArchive = await JSZip.loadAsync(sb3);
  const input = JSON.parse(await parsedArchive.file('project.json').async('text'));
  const machine = new VM();
  let bundle;
  try {
    machine.setCompilerOptions({enabled: true, warpTimer: false});
    bundle = await machine.compileProjectFromJSON(input, parsedArchive);
  } finally { machine.quit(); }
  const root = actualVMRoot();
  const files = ['src/virtual-machine.js', 'src/compiler/compile.js', 'src/compiler/irgen.js',
    'src/compiler/iroptimizer.js', 'src/compiler/jsgen.js', 'src/compiler/jsexecute.js'];
  const sourceSha256 = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await fsp.readFile(path.join(root, file)))])));
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  return {bundle, archive: parsedArchive, bytes: sb3, provenance: {
    kind: 'actual-02engine-vm-compiler', api: 'VirtualMachine.compileProjectFromJSON',
    vmRoot: root, vmVersion: pkg.version, node: process.version, inputSb3Sha256: hash(sb3), sourceSha256,
    compilerOptions: {enabled: true, warpTimer: false},
    adapters: {renderer: false, audio: false, storage: false}, packager: false
  }};
}

/** Trusted test projects only: factorySource is evaluated by the actual VM here, not by recovery. */
export async function runReal02(project, assets = {}, {bundle = null, steps = 100} = {}) {
  const VM = actualVMClass();
  const machine = new VM();
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(project));
  for (const [name, data] of Object.entries(assets)) archive.file(name, data);
  try {
    machine.setCompilerOptions({enabled: true, warpTimer: false});
    if (bundle) await machine.loadCompiledProject(structuredClone(bundle), archive);
    else await machine.loadProject(await archive.generateAsync({type: 'uint8array'}));
    machine.greenFlag();
    const compiled = machine.runtime.threads.filter(thread => !thread.updateMonitor).map(thread => thread.isCompiled);
    for (let i = 0; i < steps && machine.runtime.threads.length; i++) {
      machine.runtime._step();
      await new Promise(resolve => setImmediate(resolve));
    }
    return {compiled, remainingThreads: machine.runtime.threads.filter(thread => !thread.updateMonitor).length,
      targets: machine.runtime.targets.filter(target => target.isOriginal).map(target => ({
        name: target.getName(), isStage: target.isStage, x: target.x, y: target.y, direction: target.direction,
        size: target.size, visible: target.visible,
        variables: Object.fromEntries(Object.entries(target.variables).map(([id, variable]) => [id, {name: variable.name, type: variable.type, value: structuredClone(variable.value)}]))
      }))};
  } finally { machine.quit(); }
}
