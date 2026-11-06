import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '@babel/parser';
import {prettifyFactorySource} from '../src/pretty-code.mjs';

const FACTORY = `(function _0x3f3a46(thread) {
  const target = thread.target;
  const runtime = target.runtime;
  const stage = runtime.getTargetForStage();
  const _0xe6c410 = stage.variables["id-lightmod"];
  const _0x3e7717 = target.variables["id-levelref"];
  return function* _0x4fb5a4() {
    for (var _0x51b4ee = 0; _0x51b4ee < 10; _0x51b4ee++) {
      _0xe6c410.value.push(_0x51b4ee);
      startHats("eventWhenbroadcastreceived", {BROADCAST_OPTION: "StartGame"});
    }
    const _0xabc123 = _0x3e7717.value.length;
    yield* waitThreads([]);
  };
})`;

const resolver = (scope, id) => {
  if (scope === 'stage' && id === 'id-lightmod') return {name: 'LightMod-list', kind: 'list'};
  if (scope === 'target' && id === 'id-levelref') return {name: 'LevelRef', kind: 'variable'};
  return null;
};

test('工厂别名/计数器/临时量/函数名确定性重命名，helper 不动', () => {
  const {code, report} = prettifyFactorySource(FACTORY, {resolveBinding: resolver, innerName: 'script'});
  assert.equal(report.applied, true, JSON.stringify(report));
  assert.equal(report.verification, 'passed');
  assert.equal(report.envelope, 'factory');
  assert.ok(code.includes('(function factory(thread)'));
  assert.ok(code.includes('const l_LightMod_list = stage.variables["id-lightmod"]'));
  assert.ok(code.includes('const v_LevelRef = target.variables["id-levelref"]'));
  assert.ok(code.includes('return function* script()'));
  assert.ok(code.includes('for (var i0 = 0; i0 < 10; i0++)'));
  assert.ok(code.includes('l_LightMod_list.value.push(i0)'));
  assert.ok(code.includes('const t0 = v_LevelRef.value.length'));
  // 运行时 helper 与参数必须原样
  assert.ok(code.includes('startHats('));
  assert.ok(code.includes('waitThreads('));
  assert.ok(!code.includes('_0x'));
  // 输出可解析
  parse(code, {sourceType: 'unambiguous', allowReturnOutsideFunction: true});
});

test('无元数据解析器时别名保留原名并记录原因', () => {
  const {code, report} = prettifyFactorySource(FACTORY, {});
  assert.equal(report.applied, true);
  assert.ok(code.includes('_0xe6c410')); // 别名保留
  assert.ok(code.includes('(function factory(thread)')); // 其他仍美化
  const kept = report.kept.filter(k => k.reason === 'no-project-metadata');
  assert.equal(kept.length, 2);
});

test('同名变量清洗后撞名时确定性加后缀', () => {
  const code = `(function f(thread) {
    const target = thread.target;
    const _0xaa = target.variables["id-a"];
    const _0xbb = target.variables["id-b"];
    return function g() { _0xaa.value = _0xbb.value; };
  })`;
  const resolve = (scope, id) => id === 'id-a' ? {name: 'my var', kind: 'variable'} : {name: 'my-var', kind: 'variable'};
  const {code: out, report} = prettifyFactorySource(code, {resolveBinding: resolve});
  assert.equal(report.applied, true, JSON.stringify(report));
  assert.ok(out.includes('const v_my_var = '));
  assert.ok(out.includes('const v_my_var_2 = '));
});

test('通用 JS（非工厂外壳）只动混淆形态局部绑定', () => {
  const code = `function top() {
    const _0xdead = 40 + 2;
    let _0xbeef = _0xdead * 2;
    return _0xbeef;
  }
  top();`;
  const {code: out, report} = prettifyFactorySource(code, {});
  assert.equal(report.envelope, 'generic');
  assert.equal(report.applied, true, JSON.stringify(report));
  assert.ok(out.includes('const t0 = 40 + 2'));
  assert.ok(out.includes('let t1 = t0 * 2'));
  assert.ok(out.includes('function top()')); // 非工厂函数名不动
});

test('编译器池名与无可改名时保持原文', () => {
  const code = `(function factory0(thread) {
    const target = thread.target;
    return function gen0() { const a0 = target.x; return a0; };
  })`;
  const {code: out, report} = prettifyFactorySource(code, {});
  assert.equal(report.verification, 'passed');
  // factory0/gen0/a0 不是混淆形态也不是别名：仅工厂外壳函数名会被规范化
  assert.ok(!out.includes('_0x'));
  parse(out, {sourceType: 'unambiguous'});
});

test('嵌套同名遮蔽不产生错误重命名（一致性验证兜底）', () => {
  const code = `(function _0xf1(thread) {
    const target = thread.target;
    return function _0xf2() {
      let _0xaa = 1;
      {
        let _0xaa = 2;
        _0xaa = _0xaa + 1;
      }
      return _0xaa;
    };
  })`;
  const {code: out, report} = prettifyFactorySource(code, {});
  parse(out, {sourceType: 'unambiguous'}); // 无论是否应用都必须可解析
  if (!report.applied) assert.equal(out, code); // 回退则逐字节等于输入
  else {
    // 应用了改名：两个 _0xaa 必须映射到同一新名或验证已拒绝
    assert.equal(report.verification, 'passed');
  }
});

test('过程内层函数名由调用方给定（proc_ 前缀）', () => {
  const code = `(function _0xf1(thread) {
    const target = thread.target;
    return function _0xf2(p0, p1) { target.moveSteps(p0); return p1; };
  })`;
  const {code: out, report} = prettifyFactorySource(code, {innerName: 'proc_random_n_n_b'});
  assert.equal(report.applied, true, JSON.stringify(report));
  assert.ok(out.includes('return function proc_random_n_n_b(p0, p1)'));
  assert.ok(out.includes('p0') && out.includes('p1')); // 位置参数不动
});

test('改名后全局引用集合不变（无捕获）', () => {
  const {code, report} = prettifyFactorySource(FACTORY, {resolveBinding: resolver});
  assert.equal(report.applied, true);
  for (const globalName of ['startHats', 'waitThreads', 'BROADCAST_OPTION', 'StartGame']) {
    assert.ok(code.includes(globalName), `${globalName} 必须保留`);
  }
});
