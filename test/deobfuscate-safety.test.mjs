import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

const observe = source => {
  const context = vm.createContext({}, {codeGeneration: {strings: false, wasm: false}});
  try {return {value: JSON.parse(new vm.Script(`JSON.stringify((()=>{${source}})())`).runInContext(context, {timeout: 300}))};}
  catch (error) {return {error: error.name};}
};
const equivalence = source => {
  const result = deobfuscate(source);
  assert.deepEqual(observe(result.code), observe(source), result.code);
  return result;
};

test('点号成员重写时不使用宿主成员折叠，并保持changed语义', () => {
  const source = 'String.fromCharCode=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('计算属性成员重写时不使用宿主成员折叠，并保持changed语义', () => {
  const source = 'String["fromCharCode"]=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('内置对象别名成员重写时保持changed语义', () => {
  const source = 'const S=String;S.fromCharCode=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('多级内置对象别名成员重写时保持changed语义', () => {
  const source = 'const S=String;const T=S;T.fromCharCode=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('函数先出现、别名后声明时仍通过两阶段绑定传播保持changed语义', () => {
  const source = 'function change(){T.fromCharCode=()=>"changed";}const S=String;const T=S;change();return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('通过赋值建立的可变内置别名保持changed语义', () => {
  const source = 'let S;S=String;S.fromCharCode=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('String整体替换时不把对象成员当宿主内置，并保持changed语义', () => {
  const source = 'String={fromCharCode:()=>"changed"};return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200});
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('点号成员删除时保持TypeError语义，不折叠为宿主fromCharCode', () => {
  const source = 'delete String.fromCharCode;return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => {
    try { return {value: vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200})}; }
    catch (error) { return {error: error.name}; }
  };
  assert.deepEqual(execute(source), {error: 'TypeError'});
  assert.deepEqual(execute(result.code), {error: 'TypeError'});
});

test('计算属性成员删除时保持TypeError语义', () => {
  const source = 'delete String["fromCharCode"];return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => {
    try { return {value: vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200})}; }
    catch (error) { return {error: error.name}; }
  };
  assert.deepEqual(execute(source), {error: 'TypeError'});
  assert.deepEqual(execute(result.code), {error: 'TypeError'});
});

test('成员后缀自增时保持TypeError语义', () => {
  const source = 'String.fromCharCode++;return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => {
    try { return {value: vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200})}; }
    catch (error) { return {error: error.name}; }
  };
  assert.deepEqual(execute(source), {error: 'TypeError'});
  assert.deepEqual(execute(result.code), {error: 'TypeError'});
});

test('成员复合赋值时保持TypeError语义', () => {
  const source = 'String.fromCharCode += "";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const execute = code => {
    try { return {value: vm.runInNewContext(`(()=>{${code}})()`, {}, {timeout: 200})}; }
    catch (error) { return {error: error.name}; }
  };
  assert.deepEqual(execute(source), {error: 'TypeError'});
  assert.deepEqual(execute(result.code), {error: 'TypeError'});
});

test('不执行用户eval、Function、网络、文件或全局赋值', () => {
  delete globalThis.__deobfuscator_must_not_run;
  const source = `eval(${JSON.stringify('globalThis.__deobfuscator_must_not_run = true; require("node:fs").readFileSync("private")')});`;
  const result = deobfuscate(source);
  assert.equal(globalThis.__deobfuscator_must_not_run, undefined);
  assert.equal(result.report.executesInput, false);
  assert.ok(result.code.includes('readFileSync'));
  const dynamic = deobfuscate('eval(userInput); new Function(userCode)(); fetch(url);');
  assert.ok(dynamic.report.residuals.some(r => r.type === 'dynamic-eval'));
});

test('只化简纯计算，短路、调用顺序和单次求值保持一致', () => {
  for (const source of [
    'let n=0; false && n++; true || n++; return n;',
    'let n=0; const p={add:function(a,b){return a+b;}}; return [p.add(n++,n++),n];',
    'let n=0; const p={run:function(f,a,b){return f(a,b);}}; function f(a,b){return a+b;} return [p.run(f,n++,n++),n];',
    'const a=0x20+2*3; return [a,"hello"+" world", !![]];'
  ]) equivalence(source);
});

test('对象/数组修改、逃逸和getter不能当常量替换', () => {
  for (const source of [
    'const a=["old"]; a[0]="new"; return a[0]+"!";',
    'const a=["old"]; a.push("new"); return a.length+1;',
    'const p={text:"old"}; p.text="new"; return p.text+"!";',
    'let n=0; const p={get text(){n++; return "x";}}; return [p.text,n];',
    'const p={x:1}; function change(o){o.x=2;} change(p); return p.x+1;',
    'let n=0;function sideEffect(){n++;}function fake(){const a=["secret"];sideEffect();return a;}const x=fake().length;return [n,x];',
    'let n=0;function sideEffect(){n++;}function provider(){const a=["x","y"];return a;}function decoder(i){const a=provider();i=i-1;sideEffect();return a[i];}const x=decoder(1)+"!";return [n,x];',
    'function provider(){const a=["x","y"];return a;}function decoder(i){const a=provider();i=i-1;return a[i]+"suffix";}return decoder(1)+"!";'
  ]) equivalence(source);
});

test('保留全局声明和无法静态决定的控制流', () => {
  const result = deobfuscate('function publicAPI(x){return x*2;} const exported=7;');
  assert.ok(result.code.includes('publicAPI'));
  assert.ok(result.code.includes('exported'));
  const dynamic = deobfuscate('while(true){switch(order[index++]){case "a":doWork();continue;}break;}');
  assert.ok(dynamic.report.residuals.some(r => r.type === 'switch-dispatcher'));
});

test('作用域shadow、TDZ和动态proxy引用不误折叠', () => {
  for (const source of [
    'const x=1; function f(x){return x+2;} return f(10);',
    'return x+1; const x=2;',
    'const p={sub:function(a,b){return b-a;}}; let n=0; return [p.sub(n++,n++),n];',
    'const p={call:function(fn){return fn();}}; const o={x:3,m(){return this.x;}}; return p.call(o.m);',
    'const p={op:function(a,b){return a+b;},op:function(a,b){return a-b;}};return p.op(5,2);',
    'const a=[{x:1}];a[0].x=2;return a[0].x+1;',
    'let x=5;function f(){return (function(){return arguments[0];})();}return f(2);',
    'let trace=[];const order="0|1|2".split("|");let i=0;while(true){switch(order[i++]){case "0":trace.push("a");continue;case "1":if(true)break;trace.push("bad");continue;case "2":return trace;}break;}return trace;'
  ]) equivalence(source);
});

test('静态求值预算有限，报告不宣称未知语义得到证明', () => {
  const source='const a="a"; let b=0; for(let i=0;i<1000000000;i++){b++;} unknown(b+a);';
  const result=deobfuscate(source,{maxSteps:10,maxRounds:2});
  assert.equal(result.report.executesInput,false);
  assert.equal(result.report.behaviorEquivalenceVerified,false);
  assert.ok(result.code.includes('1000000000'));
  assert.throws(()=>deobfuscate('x()', {maxRounds:100}), /out of range/);
});
