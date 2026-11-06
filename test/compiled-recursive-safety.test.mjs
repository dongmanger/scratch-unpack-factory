import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {decodeCompiledFactory} from '../src/compiled-factory.mjs';
import {compileReal02, runReal02} from './real-02-compiler.mjs';

const factory = body => `(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];const b1=stage.variables["globalList"];return function* body(){${body}retire();return;};})`;

for (const [label, body] of [
  ['原生JS truthiness', 'if(b0.value){b0.value=1;}'],
  ['值返回逻辑运算', 'b0.value=b0.value||"fallback";'],
  ['原生数字字符串比较', 'b0.value="1".toLowerCase()==="01".toLowerCase();'],
  ['列表内容compiler/interpreter差异', 'b0.value=listContents(b1);'],
  ['列表混合类型索引差异', 'b0.value=listIndexOf(b1,"1");'],
  ['原生列表分数索引', 'b0.value=b1.value[1.5-1]??"";'],
  ['原生列表keyword索引', 'b0.value=b1.value["last"-1]??"";'],
  ['原生列表int32 keyword', 'b0.value=b1.value[("last"|0)-1]??"";'],
  ['列表超范围helper索引', 'b0.value=listGet(b1.value,4294967297);'],
  ['动态列表索引', 'b0.value=listGet(b1.value,b0.value);'],
  ['无调度循环', 'for(var i=2;i>0;i--){b0.value=1;}'],
  ['条件调度循环', 'for(var i=2;i>0;i--){b0.value=1;if(isStuck())yield;}'],
  ['repeat >0分数次数', 'for(var i=1.4;i>0;i--){b0.value=1;yield;}'],
  ['yield委派赋值', 'yield* (b0.value="abc");'],
  ['局部helper遮蔽', 'for(var retire=0;retire>0;retire--){b0.value=1;yield;}'],
  ['NaN保留算术', 'b0.value=Math.sqrt(-1)+1;'],
  ['NaN保留一元加', 'b0.value=+Math.sqrt(-1);'],
  ['toNotNaN非数值', 'b0.value=toNotNaN("abc");'],
  ['toNotNaN字符串拼接', 'b0.value=toNotNaN("1"+2);'],
  ['toNotNaN未知调用', 'b0.value=toNotNaN(unknown());'],
  ['toNotNaN未证明NaN内层算术', 'b0.value=toNotNaN(Math.sqrt(-1)+1);'],
  ['toNotNaN不丢弃未知尾句', 'b0.value=toNotNaN(1/(+b0.value||0));unknown();'],
  ['未舍入size读取', 'b0.value=target.size;'],
  ['字符串位移相加', 'target.setXY(target.x+"2",target.y);'],
  ['字符串旋转相加', 'target.setDirection(target.direction+"2");'],
  ['字符串size相加', 'target.setSize(target.size+"2");']
]) {
  test(`${label}不冒充可编辑等价恢复`, async () => {
    const fixture = await compiledFixture();
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory(body);
    const project = structuredClone(fixture.stripped);
    const result = recoverCompiledCode(project, fixture.bundle);
    assert.equal(result.scripts[0].status, 'unresolved', body);
    assert.equal(result.scripts[0].body.confidence.score, 0);
    assert.deepEqual(Object.values(project.targets[0].blocks).map(block => block.opcode), ['event_whenflagclicked']);
    assert.ok(result.scripts[0].reason);
  });
}

for (const input of [0, 'not numeric', 2, -2, 'Infinity']) {
  test(`toNotNaN numeric arithmetic recovers without discarding casts: ${String(input)}`, async () => {
    const fixture = await compiledFixture();
    fixture.stripped.targets[0].variables.varId1[1] = input;
    const source = factory('b0.value=toNotNaN((+b0.value||0)/(+b0.value||0));');
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = source;
    const decoded = decodeCompiledFactory(source, fixture.stripped, 0);
    assert.equal(decoded.operations[0].inputs.VALUE.opcode, 'operator_multiply', 'NaN cast keeps signed zero');
    const project = structuredClone(fixture.stripped);
    const result = recoverCompiledCode(project, fixture.bundle, {beautify: false});
    assert.equal(result.scripts[0].status, 'reconstructed-unverified', result.scripts[0].reason);
    const regenerated = await compileReal02(project, fixture.assets);
    const after = await runReal02(project, fixture.assets, {bundle: regenerated.bundle});
    const numeric = Number(input) || 0;
    const quotient = numeric / numeric;
    const actual = after.targets[0].variables.varId1.value;
    assert.equal(actual, Number.isNaN(quotient) ? 0 : quotient);
  });
}

test('toNotNaN retains signed zero and infinities through a real compiler roundtrip', async () => {
  const fixture = await compiledFixture();
  const expressions = ['Math.floor(toNotNaN(-1/(+b0.value||0)))',
    'toNotNaN(0-(+b0.value||0))', 'toNotNaN(-(+b0.value||0))'];
  for (const expression of expressions) {
    const project = structuredClone(fixture.stripped);
    project.targets[0].variables.varId1[1] = 'Infinity';
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory(`b0.value=${expression};`);
    const result = recoverCompiledCode(project, fixture.bundle, {beautify: false});
    assert.equal(result.scripts[0].status, 'reconstructed-unverified', result.scripts[0].reason);
    const regenerated = await compileReal02(project, fixture.assets);
    const after = await runReal02(project, fixture.assets, {bundle: regenerated.bundle});
    const expected = expression.startsWith('Math.floor') ? -0 : -Infinity;
    assert.ok(Object.is(after.targets[0].variables.varId1.value, expected), expression);
  }
});

test('布尔值赋值可用真实布尔reporter表达，保持类型而非数字shadow', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory('b0.value=true;');
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.scripts[0].status, 'reconstructed-unverified');
  assert.ok(Object.values(project.targets[0].blocks).some(block => block.opcode === 'operator_equals'));
});

for (const [label, body] of [
  ['深度嵌套语句块', '{'.repeat(80) + 'b0.value=1;' + '}'.repeat(80)],
  ['深度嵌套布尔取反', `b0.value=${'!'.repeat(300)}compareEqual(1,1);`],
  ['深度嵌套算术括号', `b0.value=${'('.repeat(300)}1${') + 0'.repeat(300)};`]
]) {
  test(`${label}在预算上限处干净失败，而非栈溢出`, async () => {
    const fixture = await compiledFixture();
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory(body);
    const project = structuredClone(fixture.stripped);
    const result = recoverCompiledCode(project, fixture.bundle);
    assert.equal(result.scripts[0].status, 'unresolved');
    assert.ok(result.scripts[0].reason, label);
    assert.deepEqual(Object.values(project.targets[0].blocks).map(block => block.opcode), ['event_whenflagclicked']);
  });
}
