import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';

/**
 * 无损代码美化（pretty-code）：对已解混淆的 factorySource 做**仅标识符重命名**的
 * 可读性恢复。不执行输入、不改字面量、不改结构。
 *
 * 无歧义原则：
 * - 只重命名工厂源码内部声明的绑定（局部变量/函数名），从不触碰未绑定引用
 *   （startHats 等运行时 helper 保持原名，因为它们必须在全局运行时解析）。
 * - 变量/列表别名的新名来自工程元数据的权威反查（variables["id"] → 真实名），
 *   不是猜测；反查不到就保留原名并记录原因。
 * - 新名在全程序唯一且不与任何现存标识符冲突（taken 集合），杜绝捕获。
 * - 每次转换后做逆向结构比对验证（α-等价检查）：改名映射必须是全局一致的
 *   双射，其余节点字段逐位相等；任何不一致整体回退到输入原文。
 */
const traverse = traverseModule.default || traverseModule;
const generate = generatorModule.default || generatorModule;
const printer = ast => generate(ast, {comments: false, compact: false, jsescOption: {minimal: false}}).code;
const parser = source => parse(source, {sourceType: 'unambiguous', errorRecovery: false, allowReturnOutsideFunction: true});

const OBFUSCATED_NAME = /^_0x[0-9a-f]+$/i;
const CANONICAL_PARAMS = new Set(['thread', 'target', 'runtime', 'stage']);
const IDENTIFIER_START = /^[A-Za-z_$]/;
const MAX_REPORT_ENTRIES = 100;

const sanitizeIdentifier = name => {
  const cleaned = String(name).replace(/[^A-Za-z0-9_$]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned && IDENTIFIER_START.test(cleaned) ? cleaned : '';
};

/** 绑定节点上的名字：函数名在 id 上，变量声明在 id 上，其余在 name 上。 */
const bindingName = binding => {
  const node = binding.path.node;
  if (binding.path.isFunction()) return node.id?.name;
  if (t.isIdentifier(node)) return node.name;
  if (t.isVariableDeclarator(node)) return t.isIdentifier(node.id) ? node.id.name : undefined;
  return undefined;
};

const META_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments']);

/** `target.variables["id"]` / `stage.variables["id"]`（也容忍 .lists）→ {scope, id} */
const variableAliasOf = init => {
  if (!t.isMemberExpression(init) || !init.computed || !t.isStringLiteral(init.property)) return null;
  const outer = init.object;
  if (!t.isMemberExpression(outer) || outer.computed || !t.isIdentifier(outer.property)) return null;
  if (outer.property.name !== 'variables' && outer.property.name !== 'lists') return null;
  if (!t.isIdentifier(outer.object, {name: 'target'}) && !t.isIdentifier(outer.object, {name: 'stage'})) return null;
  return {scope: outer.object.name, id: init.property.value};
};

/** 工厂外壳：单一顶层函数表达式，末尾 return 内层函数。不匹配则按通用 JS 处理。 */
const detectEnvelope = ast => {
  const statement = ast.program.body.length === 1 ? ast.program.body[0] : null;
  if (!t.isExpressionStatement(statement) || !t.isFunctionExpression(statement.expression)) return {kind: 'generic'};
  const outer = statement.expression;
  const last = outer.body.body[outer.body.body.length - 1];
  const inner = t.isReturnStatement(last) && t.isFunction(last.argument) ? last.argument : null;
  return {kind: 'factory', outer, inner};
};

/** 确定性遍历顺序收集全部绑定（Program → 嵌套作用域）；函数体块与函数共享
 *  绑定表会重复列出同一绑定，按对象身份去重。 */
const collectBindings = ast => {
  const bindings = [];
  const seen = new Set();
  traverse(ast, {Scopable(path) {
    for (const name of Object.keys(path.scope.bindings)) {
      const binding = path.scope.bindings[name];
      if (seen.has(binding)) continue;
      seen.add(binding);
      bindings.push(binding);
    }
  }});
  return bindings;
};

const collectIdentifierNames = ast => {
  const names = new Set();
  const walk = node => {
    if (!node) return;
    if (t.isIdentifier(node)) names.add(node.name);
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value) walk(value);
    }
  };
  walk(ast.program);
  return names;
};

/**
 * 逆向结构比对：parallel walk 两棵 AST，除 Identifier.name 外逐字段相等；
 * 标识符改名映射必须全局一致（同一原名处处映射到同一新名、不同原名不得
 * 撞同一新名）。一致 ⇒ α-等价（新名全局唯一无捕获），否则验证失败。
 */
const verifyAlphaEquivalent = (originalProgram, renamedProgram) => {
  const nameMap = new Map();
  const usedNew = new Map();
  const compare = (a, b) => {
    if (!a && !b) return true;
    if (!a || !b || a.type !== b.type) return false;
    if (t.isIdentifier(a)) {
      const seen = nameMap.get(a.name);
      if (seen === undefined) {
        const prior = usedNew.get(b.name);
        if (prior !== undefined && prior !== a.name) return false;
        nameMap.set(a.name, b.name);
        usedNew.set(b.name, a.name);
        return true;
      }
      return seen === b.name;
    }
    const childKeys = t.VISITOR_KEYS[a.type] || [];
    for (const key of Object.keys(a)) {
      if (META_KEYS.has(key) || childKeys.includes(key)) continue;
      if (key === 'name' && t.isIdentifier(a)) continue;
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'object' && va !== null) {
        if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
        continue;
      }
      if (va !== vb) return false;
    }
    if (childKeys.length !== (t.VISITOR_KEYS[b.type] || []).length) return false;
    for (const key of childKeys) {
      const va = a[key];
      const vb = b[key];
      if (Array.isArray(va)) {
        if (!Array.isArray(vb) || va.length !== vb.length) return false;
        for (let i = 0; i < va.length; i++) if (!compare(va[i], vb[i])) return false;
      } else if (!compare(va, vb)) return false;
    }
    return true;
  };
  if (!compare(originalProgram, renamedProgram)) return {ok: false, reason: 'structure-or-name-map-inconsistent'};
  return {ok: true, nameMap};
};

/**
 * @param {string} code 已解混淆的 JS（任意 JS 也可，工厂形状获得更多命名）
 * @param {object} options
 * @param {(scope:'target'|'stage', id:string) => ({name:string, kind:'variable'|'list'}|null)|null} options.resolveBinding
 *        变量/列表 ID → 元数据名的权威反查；缺省时别名保留原名。
 * @param {string} [options.innerName] 内层函数命名（脚本 'script' / 过程 'proc_…'）
 * @param {string} [options.factoryName] 外层工厂函数命名（默认 'factory'）
 * @returns {{code: string, report: object}} 验证失败或无法解析时 code 恒等于输入
 */
export function prettifyFactorySource(code, {resolveBinding = null, innerName = 'script', factoryName = 'factory'} = {}) {
  const report = {applied: false, verification: 'not-run', envelope: 'generic',
    renamedCount: 0, keptCount: 0, renamed: [], kept: [], truncated: false};
  const fail = (stage, reason) => {
    report.verification = stage;
    report.reason = reason;
    report.renamed.length = Math.min(report.renamed.length, MAX_REPORT_ENTRIES);
    report.kept.length = Math.min(report.kept.length, MAX_REPORT_ENTRIES);
    return {code, report};
  };
  if (typeof code !== 'string' || !code.length) return fail('skipped', 'empty-input');
  let ast;
  try {
    ast = parser(code);
  } catch (error) {
    return fail('skipped', `parse-error: ${error.message}`);
  }
  const envelope = detectEnvelope(ast);
  report.envelope = envelope.kind;

  const taken = collectIdentifierNames(ast);
  const bindings = collectBindings(ast);
  const bindingByNode = new Map(bindings.map(binding => [binding.path.node, binding]));
  const renames = [];
  const kept = [];
  let counterIndex = 0;
  let tempIndex = 0;

  const claim = base => {
    if (!base || !IDENTIFIER_START.test(base)) return null;
    let candidate = base;
    for (let suffix = 2; taken.has(candidate) || CANONICAL_PARAMS.has(candidate); suffix++) candidate = `${base}_${suffix}`;
    taken.add(candidate);
    return candidate;
  };
  const planRename = (binding, base, kind) => {
    const from = bindingName(binding);
    if (!from || CANONICAL_PARAMS.has(from)) return;
    const to = claim(base);
    if (!to) {kept.push({name: from, reason: `unnamable-${kind}`}); return;}
    if (to === from) return;
    renames.push({binding, from, to, kind});
  };

  for (const binding of bindings) {
    const node = binding.path.node;
    const name = bindingName(binding);
    if (!name || CANONICAL_PARAMS.has(name)) continue;
    if (binding.kind === 'param') continue; // thread / p0..pN 位置签名，不动
    if (binding.path.isFunction()) {
      if (envelope.kind === 'factory' && node === envelope.outer && node.id) planRename(binding, factoryName, 'factory-name');
      else if (envelope.kind === 'factory' && envelope.inner && node === envelope.inner && node.id) planRename(binding, innerName, 'script-name');
      continue; // 其他具名函数保持原名：无法确定其语义角色
    }
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) continue;
    const alias = variableAliasOf(node.init);
    if (alias) {
      const resolved = resolveBinding ? resolveBinding(alias.scope, alias.id) : null;
      if (resolved && typeof resolved.name === 'string' && resolved.name.length) {
        const prefix = resolved.kind === 'list' ? 'l_' : 'v_';
        const base = sanitizeIdentifier(resolved.name);
        if (base) planRename(binding, `${prefix}${base}`, `${alias.scope}-${resolved.kind || 'variable'}-alias`);
        else kept.push({name, reason: 'metadata-name-not-an-identifier'});
      } else {
        kept.push({name, reason: resolveBinding ? 'variable-metadata-unresolved' : 'no-project-metadata'});
      }
      continue;
    }
    if (!OBFUSCATED_NAME.test(name)) continue; // 编译器池名（a0/b0/fun0…）已可读，不动
    const isCounter = binding.path.parentPath?.isVariableDeclaration() &&
      binding.path.parentPath.parentPath?.isForStatement() &&
      binding.path.parentPath.parentPath.node.init === binding.path.parentPath.node;
    if (isCounter) {
      let base;
      do {base = `i${counterIndex++}`;} while (taken.has(base));
      planRename(binding, base, 'loop-counter');
    } else {
      let base;
      do {base = `t${tempIndex++}`;} while (taken.has(base));
      planRename(binding, base, 'temporary');
    }
  }

  for (const {binding, from, to, kind} of renames) {
    try {
      binding.scope.rename(from, to);
      report.renamed.push({from, to, kind});
    } catch (error) {
      return fail('failed', `rename-error ${from}: ${error.message}`);
    }
  }
  report.renamedCount = report.renamed.length;
  report.keptCount = kept.length;
  report.kept = kept;
  if (!renames.length) {
    report.verification = 'passed';
    report.reason = 'nothing-to-rename';
    return {code, report};
  }

  const renamedCode = printer(ast);
  // 逆向验证：重解析输出，与重解析的输入做 α-等价比对
  let originalAst;
  let renamedAst;
  try {
    originalAst = parser(code);
    renamedAst = parser(renamedCode);
  } catch (error) {
    return fail('failed', `reparse-error: ${error.message}`);
  }
  const expected = new Map(renames.map(({from, to}) => [from, to]));
  const verdict = verifyAlphaEquivalent(originalAst.program, renamedAst.program);
  if (!verdict.ok) return fail('failed', verdict.reason);
  for (const [from, to] of expected) {
    if (verdict.nameMap.get(from) !== to) return fail('failed', `rename-not-reflected: ${from}`);
  }
  for (const [from] of verdict.nameMap) {
    if (!expected.has(from) && verdict.nameMap.get(from) !== from) return fail('failed', `unexpected-rename: ${from}`);
  }
  report.applied = true;
  report.verification = 'passed';
  if (report.renamed.length > MAX_REPORT_ENTRIES || report.kept.length > MAX_REPORT_ENTRIES) {
    report.truncated = true;
    report.renamed.length = Math.min(report.renamed.length, MAX_REPORT_ENTRIES);
    report.kept.length = Math.min(report.kept.length, MAX_REPORT_ENTRIES);
  }
  return {code: renamedCode, report};
}
