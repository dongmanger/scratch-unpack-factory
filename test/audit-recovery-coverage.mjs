import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {RECOVERY_OPCODE_SCHEMA} from '../src/recovery-opcode-schema.mjs';

// A source inventory, not a test runner or a declaration of 1.0 acceptance.
// Read an explicit manifest and only the immediate test directory. Never crawl
// research, node_modules, fixtures, or the rest of the project.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const vmRoot = path.resolve(process.env.FACTORY_02_VM_ROOT || path.join(projectRoot, 'research/02engine/scratch-vm'));
const outputDirectory = path.join(projectRoot, 'factory/fixtures/v1-coverage');
const compilerFiles = ['irgen.js', 'jsgen.js', 'enums.js', 'compat-blocks.js', 'jsexecute.js'];
const decoderFiles = ['compiled-factory.mjs', 'recovery-native-commands.mjs', 'recovery-reporters.mjs', 'recovery-executable-hats.mjs'];
const supportingFiles = ['recovery-opcode-schema.mjs', 'recovery-procedures.mjs', 'recovery-symbols.mjs',
  'recover-code.mjs', 'recovered-blocks.mjs', 'runtime-hook.mjs'];
const knownTests = ['compiled-recursive.test.mjs', 'compiled-recursive-safety.test.mjs', 'compiler-source.test.mjs',
  'real-02-recovery.test.mjs', 'recovered-blocks.test.mjs', 'fidelity-boundaries.test.mjs', 'runtime-hook.test.mjs'];
const testHelpers = ['real-02-compiler.mjs', 'real-02-recursive.mjs', 'compiled-fixtures.mjs', 'helpers.mjs'];
const sources = new Map();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...new Set(values)].sort();
const difference = (left, right) => left.filter(value => !right.includes(value));
const intersection = (left, right) => left.filter(value => right.includes(value));
const slash = value => value.split(path.sep).join('/');
const sourcePath = absolutePath => slash(path.relative(projectRoot, absolutePath));
const isOpcode = value => typeof value === 'string' && /^[a-z][a-zA-Z0-9]*_[a-zA-Z0-9_]+$/.test(value);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
const nameOf = node => node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : undefined;
const memberPath = node => node?.type === 'Identifier' ? node.name :
  node?.type === 'MemberExpression' && (!node.computed || node.property.type === 'Literal') ?
    `${memberPath(node.object)}.${nameOf(node.property)}` : '';
const declaration = (source, name) => {
  let result;
  walk(source.ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.name === name) result = node.init;
  });
  if (!result) throw new Error(`${source.path}: missing declaration ${name}`);
  return result;
};
function method(source, name) {
  let result;
  walk(source.ast, node => {
    if (node.type === 'MethodDefinition' && nameOf(node.key) === name) result = node.value;
  });
  if (!result) throw new Error(`${source.path}: missing method ${name}`);
  return result;
}
function opcodeSwitch(source, methodName) {
  const matches = method(source, methodName).body.body.filter(node =>
    node.type === 'SwitchStatement' && memberPath(node.discriminant) === 'block.opcode');
  if (matches.length !== 1) throw new Error(`${source.path}: expected one ${methodName} block.opcode dispatch`);
  return matches[0];
}
async function readSource(absolutePath, role) {
  const bytes = await fs.readFile(absolutePath);
  const text = bytes.toString('utf8');
  const file = {path: sourcePath(absolutePath), absolutePath, role, text, bytes: bytes.length,
    sha256: sha256(bytes), ast: parse(text, {ecmaVersion: 'latest', sourceType: 'module', locations: true})};
  sources.set(file.path, file);
  return file;
}
function reference(source, node, detail) {
  return {path: source.path, line: node.loc.start.line, ...(detail ? {detail} : {})};
}
function stringMentions(source) {
  const entries = [];
  walk(source.ast, node => {
    // Comments, object keys such as schema declarations, and embedded generated
    // JS strings are not exact opcode Literal values in executable decoder code.
    if (node.type === 'Literal' && isOpcode(node.value)) entries.push({opcode: node.value, ...reference(source, node)});
  });
  return entries;
}
function directCases(source, methodName) {
  return opcodeSwitch(source, methodName).cases.filter(branch => branch.test?.type === 'Literal' && isOpcode(branch.test.value))
    .map(branch => ({opcode: branch.test.value, ...reference(source, branch.test, methodName)}));
}
function enumDefinitions(source, enumName) {
  const object = declaration(source, enumName);
  if (object.type !== 'ObjectExpression') throw new Error(`${enumName} must be an object literal`);
  return object.properties.map(property => {
    if (property.type !== 'Property' || property.value.type !== 'Literal' || typeof property.value.value !== 'string') {
      throw new Error(`${enumName}: unexpected nonliteral enum value`);
    }
    return {name: nameOf(property.key), irOpcode: property.value.value, ...reference(source, property)};
  });
}
function enumCases(source, methodName) {
  return opcodeSwitch(source, methodName).cases.filter(branch => branch.test?.type === 'MemberExpression')
    .map(branch => ({enum: memberPath(branch.test).split('.')[0], name: nameOf(branch.test.property), ...reference(source, branch.test)}));
}
function compatEntries(source, name) {
  const array = declaration(source, name);
  if (array.type !== 'ArrayExpression' || array.elements.some(node => node?.type !== 'Literal' || !isOpcode(node.value))) {
    throw new Error(`${source.path}: ${name} must be a literal opcode array`);
  }
  return array.elements.map(node => ({opcode: node.value, ...reference(source, node)}));
}
function anchors(source, terms) {
  return terms.map(term => {
    const index = source.text.indexOf(term);
    if (index === -1) throw new Error(`${source.path}: missing evidence anchor ${term}`);
    const line = source.text.slice(0, index).split('\n').length;
    return {path: source.path, line, detail: term};
  });
}
function testInventory(source) {
  const declarations = [];
  walk(source.ast, node => {
    if (node.type !== 'CallExpression' || !/^test(?:\.(?:skip|todo|only))?$/.test(memberPath(node.callee))) return;
    const title = node.arguments[0];
    const staticName = title?.type === 'Literal' && typeof title.value === 'string' ? title.value :
      title?.type === 'TemplateLiteral' && title.expressions.length === 0 ? title.quasis[0].value.cooked : null;
    const callback = node.arguments.find(argument => ['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type));
    const calls = [];
    walk(callback, child => {
      if (child.type === 'CallExpression') calls.push(memberPath(child.callee));
    });
    declarations.push({name: staticName, nameTemplate: staticName === null ? source.text.slice(title.start, title.end) : null,
      ...reference(source, node), declaration: memberPath(node.callee),
      actualCompilerCallPresent: calls.includes('compileReal02'), runtimeHelperCallPresent: calls.includes('runReal02'),
      executionStatus: 'not-run-by-this-audit'});
  });
  return {path: source.path, sourceSha256: source.sha256, testDeclarationCount: declarations.length,
    generatedNamesAreNotExpanded: declarations.some(entry => entry.name === null),
    testNames: declarations, explicitOpcodeStringMentions: stringMentions(source)};
}
const md = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const evidenceText = refs => refs.map(ref => `${ref.path}:${ref.line}${ref.detail ? ` (${ref.detail})` : ''}`).join('; ');

export async function auditRecoveryCoverage() {
  sources.clear();
  const compiler = Object.fromEntries(await Promise.all(compilerFiles.map(async file =>
    [file, await readSource(path.join(vmRoot, 'src/compiler', file), 'actual-02engine-compiler')])));
  const decoders = await Promise.all(decoderFiles.map(file => readSource(path.join(projectRoot, 'factory/src', file), 'decoder')));
  const supporting = Object.fromEntries(await Promise.all(supportingFiles.map(async file =>
    [file, await readSource(path.join(projectRoot, 'factory/src', file), 'supporting-recovery-source')])));
  const runtime = Object.fromEntries(await Promise.all(['runtime.js', 'sequencer.js'].map(async file =>
    [file, await readSource(path.join(vmRoot, 'src/engine', file), 'actual-02engine-runtime')])));
  const immediateNames = await fs.readdir(path.join(projectRoot, 'factory/test'));
  const testFiles = sorted([...knownTests, ...immediateNames.filter(name => /^recovery-[a-z0-9-]+\.test\.mjs$/.test(name))]);
  const tests = await Promise.all(testFiles.map(file => readSource(path.join(projectRoot, 'factory/test', file), 'test-inventory')));
  await Promise.all(testHelpers.map(file => readSource(path.join(projectRoot, 'factory/test', file), 'test-helper')));
  await readSource(fileURLToPath(import.meta.url), 'audit-generator');

  const inputEntries = directCases(compiler['irgen.js'], 'descendInput');
  const stackEntries = directCases(compiler['irgen.js'], 'descendStackedBlock');
  const directInput = sorted(inputEntries.map(entry => entry.opcode));
  const directStack = sorted(stackEntries.map(entry => entry.opcode));
  const directUnion = sorted([...directInput, ...directStack]);
  const compatStackEntries = compatEntries(compiler['compat-blocks.js'], 'stacked');
  const compatInputEntries = compatEntries(compiler['compat-blocks.js'], 'inputs');
  const compatStack = sorted(compatStackEntries.map(entry => entry.opcode));
  const compatInput = sorted(compatInputEntries.map(entry => entry.opcode));
  const compatUnion = sorted([...compatStack, ...compatInput]);
  const decoderMentions = decoders.flatMap(stringMentions);
  const decoderOpcodes = sorted(decoderMentions.map(entry => entry.opcode));
  const metadataMentions = ['recovery-procedures.mjs', 'recovery-symbols.mjs'].flatMap(file => stringMentions(supporting[file]));
  const metadataOpcodes = sorted(metadataMentions.map(entry => entry.opcode));
  const schemaOpcodes = Object.keys(RECOVERY_OPCODE_SCHEMA).sort();
  const inventory = tests.map(testInventory);
  const testMentions = inventory.flatMap(file => file.explicitOpcodeStringMentions);
  const schemaOnly = difference(schemaOpcodes, sorted([...decoderOpcodes, ...metadataOpcodes]));
  const universe = sorted([...directUnion, ...compatUnion, ...schemaOpcodes, ...decoderOpcodes, ...metadataOpcodes]);
  const testOpcodeCandidates = sorted(testMentions.map(entry => entry.opcode));
  const testOpcodes = intersection(testOpcodeCandidates, universe);
  const unrecognizedTestOpcodeStrings = difference(testOpcodeCandidates, universe);
  const opcodes = universe.map(opcode => ({opcode,
    directIRInput: directInput.includes(opcode), directIRStack: directStack.includes(opcode),
    compatibilityInputEntry: compatInput.includes(opcode), compatibilityStackEntry: compatStack.includes(opcode),
    schemaPresent: Object.hasOwn(RECOVERY_OPCODE_SCHEMA, opcode),
    decoderSourceMentioned: decoderOpcodes.includes(opcode), metadataSourceMentioned: metadataOpcodes.includes(opcode),
    schemaOnly: schemaOnly.includes(opcode), testSourceMentioned: testOpcodes.includes(opcode),
    tested: null, semanticCoverageVerified: false,
    compilerEvidence: [...inputEntries, ...stackEntries, ...compatInputEntries, ...compatStackEntries].filter(entry => entry.opcode === opcode),
    decoderEvidence: decoderMentions.filter(entry => entry.opcode === opcode),
    metadataEvidence: metadataMentions.filter(entry => entry.opcode === opcode),
    testSourceEvidence: testMentions.filter(entry => entry.opcode === opcode)}));
  const enums = Object.fromEntries(['InputOpcode', 'StackOpcode'].map(name => [name, enumDefinitions(compiler['enums.js'], name)]));
  const jsgen = {
    input: enumCases(compiler['jsgen.js'], 'descendInput'),
    stack: enumCases(compiler['jsgen.js'], 'descendStackedBlock')
  };
  const features = [
    {name: 'procedures', sources: [
      ...anchors(compiler['irgen.js'], ['getProcedureInfo (block)', 'analyzeRecursion ()']),
      ...anchors(compiler['jsgen.js'], ['case InputOpcode.PROCEDURE_CALL:', 'case StackOpcode.PROCEDURE_RETURN:']),
      ...anchors(supporting['recovery-procedures.mjs'], ['collectProcedureSignatures', 'addProcedureDefinition']),
      ...anchors(supporting['recover-code.mjs'], ['额外W/Z变体的调度对应尚未验证'])],
    gaps: ['Argument names, IDs, defaults and original warp declaration are synthesized or unknown.',
      'Mixed W/Z variants and general recursion/scheduling equivalence are not verified.']},
    {name: 'warp and scheduling', sources: [
      ...anchors(compiler['irgen.js'], ['analyzeLoop ()']),
      ...anchors(compiler['jsgen.js'], ['MAX_UNROLL_ITERATIONS', 'yieldLoop ()', 'yieldStuckOrNotWarp ()']),
      ...anchors(decoders[0], ['warp循环出现非warp调度', 'warp等待调度尚未验证'])],
    gaps: ['Warp timers, unrolling, yielding, promises and timing need behavior tests per template and mode.',
      'The source inventories do not verify scheduler equivalence.']},
    {name: 'edge and predicate hats', sources: [
      ...anchors(compiler['irgen.js'], ['walkHat (hatBlock)', 'hatInfo.edgeActivated']),
      ...anchors(compiler['jsgen.js'], ['case StackOpcode.HAT_EDGE:', 'case StackOpcode.HAT_PREDICATE:']),
      ...anchors(decoders[3], ['export function decodeExecutableHat', 'edge state, activation, retirement, or yield']),
      ...anchors(supporting['recover-code.mjs'], ['executableHat'])],
    gaps: [supporting['recover-code.mjs'].text.includes('可执行事件条件尚未验证') ?
      'The standalone executable-hat decoder has source/test inventory evidence, but recover-code still rejects executable hats.' :
      'Executable-hat source/test inventory evidence does not verify production integration or runtime edge behavior.',
      'Metadata hat reconstruction and compile-only shape tests do not prove edge-state behavior.']},
    {name: 'runtime and compatibility', sources: [
      ...anchors(compiler['irgen.js'], ['descendCompatLayerInput (block)', 'descendCompatLayerStack (block)']),
      ...anchors(compiler['jsgen.js'], ['generateCompatibilityLayerCall (node, setFlags, frameName = null)']),
      ...anchors(compiler['jsexecute.js'], ['const executeInCompatibilityLayer = function*']),
      ...anchors(runtime['runtime.js'], ['getOpcodeFunction (opcode)', 'startHats (requestedHatOpcode', '_step ()']),
      ...anchors(runtime['sequencer.js'], ['stepThreads ()', 'stepThread (thread)'])],
    gaps: ['Extension dispatch is dynamic and this finite opcode inventory cannot enumerate it.',
      'Schemas describe arguments, not native decoder implementations or verified runtime behavior.',
      'Compatibility reporters/branch frames and dynamic menu defaults lack general recovery support.',
      'Renderer, audio, pen raster output, cloud services and external devices require separate behavioral evidence.']},
    {name: 'reporter and index boundaries', sources: [
      ...anchors(decoders[0], ['02列表内容helper与解释器数字项拼接语义不同', '02列表索引helper与解释器混合数字/字符串相等语义不同',
        '动态列表索引的int32转换与解释器floor差异尚未证明', '列表折叠索引缺少有限非负整数证明']),
      ...anchors(decoders[2], ['Letter index requires a finite literal integer', 'Touching-color recovery requires a literal'])],
    gaps: ['A source-mentioned opcode may still be rejected for some or all argument/template variants.',
      'General list contents/index equality, dynamic indices, SENSING_OF aliases and dynamic colors are not proved.']}
  ];
  const counts = {
    directIRInputDistinctScratchOpcodes: directInput.length,
    directIRStackDistinctScratchOpcodes: directStack.length,
    directIRUnionDistinctScratchOpcodes: directUnion.length,
    directIRInputStackOverlap: intersection(directInput, directStack).length,
    compatibilityInputEntries: compatInputEntries.length, compatibilityStackEntries: compatStackEntries.length,
    compatibilityDistinctScratchOpcodes: compatUnion.length,
    compatibilityDirectIROverlap: intersection(compatUnion, directUnion).length,
    schemaEntries: schemaOpcodes.length, decoderSourceMentionedDistinctScratchOpcodes: decoderOpcodes.length,
    metadataSourceMentionedDistinctScratchOpcodes: metadataOpcodes.length,
    schemaAndDecoderSourceMentioned: intersection(schemaOpcodes, decoderOpcodes).length,
    schemaWithoutDecoderStringMention: difference(schemaOpcodes, decoderOpcodes).length,
    schemaOnlyNoDecoderOrMetadataStringMention: schemaOnly.length,
    directIRWithoutDecoderStringMention: difference(directUnion, decoderOpcodes).length,
    compatibilityWithoutSchema: difference(compatUnion, schemaOpcodes).length,
    testInventoryFiles: inventory.length, testSourceMentionedDistinctScratchOpcodes: testOpcodes.length,
    unrecognizedTestOpcodeShapedStrings: unrecognizedTestOpcodeStrings.length,
    testCallDeclarations: inventory.reduce((sum, file) => sum + file.testDeclarationCount, 0),
    inputIREnumEntries: enums.InputOpcode.length, stackIREnumEntries: enums.StackOpcode.length,
    jsgenInputEnumDispatchCases: jsgen.input.length, jsgenStackEnumDispatchCases: jsgen.stack.length,
    behaviorTestsRunByAudit: 0, semanticVerifiedOpcodeCount: 0
  };
  const report = {
    format: 'recovery-coverage-source-audit', target: 'honest1.0',
    semanticCoverageVerified: false, goalComplete: false, testExecutionPerformed: false,
    originalGraphUnique: false,
    originalGraph: 'Compilation folds constants, erases branches, unrolls loops and discards IDs/layout/metadata. Multiple original block graphs can yield the same factory source.',
    methodology: {
      scope: 'Only the explicit source manifest and immediate recovery test filenames; no recursive project scan.',
      compiler: 'AST cases of the outer block.opcode switches in irgen.descendInput/descendStackedBlock. Nested selector cases are excluded; menu/constants and procedures are included.',
      compatibility: 'Literal arrays from compat-blocks.js; entries overlapping direct cases do not imply the fallback is used.',
      decoder: 'Exact opcode string Literal values from the explicitly listed decoder files only. No schema keys/comments/embedded code strings, metadata helpers or enum names count toward this total.',
      schema: 'Imported RECOVERY_OPCODE_SCHEMA is argument metadata only. Schema-only entries never count as decoder implementation.',
      tests: 'Static test names/name templates and exact opcode literal mentions are inventory evidence only, including negative/shape/schema tests. Counts of known opcodes exclude opcode-shaped strings absent from the compiler/schema/decoder union. Generated families are not expanded or counted as executed tests.',
      verification: 'Source-mentioned, test-source-mentioned and behavior-tested are distinct. tested:null means no run result; no implementation or semantic coverage percentage is inferred.'
    },
    counts,
    sourceSha256: Object.fromEntries([...sources.values()].sort((a, b) => a.path.localeCompare(b.path)).map(source => [source.path, source.sha256])),
    sourceManifest: [...sources.values()].map(({path: file, absolutePath, role, bytes}) => ({path: file, absolutePath, role, bytes})).sort((a, b) => a.path.localeCompare(b.path)),
    compiler: {vmRoot, directIR: {inputOpcodes: directInput, stackOpcodes: directStack, distinctOpcodes: directUnion,
      inputEntries, stackEntries}, compatibility: {inputOpcodes: compatInput, stackOpcodes: compatStack,
      distinctOpcodes: compatUnion, directIROverlap: intersection(compatUnion, directUnion), inputEntries: compatInputEntries, stackEntries: compatStackEntries},
    enums, jsgen},
    recovery: {decoderFiles, decoderSourceMentionedOpcodes: decoderOpcodes, decoderMentions,
      metadataSourceMentionedOpcodes: metadataOpcodes, metadataMentions, schemaOpcodes,
      schemas: RECOVERY_OPCODE_SCHEMA, schemaAndDecoderSourceMentionedOpcodes: intersection(schemaOpcodes, decoderOpcodes),
      schemaWithoutDecoderStringMention: difference(schemaOpcodes, decoderOpcodes), schemaOnlyOpcodes: schemaOnly,
      decoderMentionedWithoutSchema: difference(decoderOpcodes, schemaOpcodes)},
    gaps: {directIRWithoutDecoderStringMention: difference(directUnion, decoderOpcodes),
      compatibilityWithoutSchema: difference(compatUnion, schemaOpcodes),
      decoderMentionedWithoutTestSourceMention: difference(decoderOpcodes, testOpcodes),
      schemaOnlyOpcodes: schemaOnly,
      missingMentionIsNotProofOfUnsupported: true,
      sourceMentionIsNotProofOfImplementation: true},
    features, testEvidence: {knownOpcodeSourceMentions: testOpcodes, unrecognizedTestOpcodeStrings,
      executionPerformed: false, semanticCoverageVerified: false}, testInventory: inventory, opcodes
  };
  const lines = ['# Recovery coverage source audit — honest1.0', '',
    '**semanticCoverageVerified: false · goalComplete: false · behavior tests run: 0**', '',
    'This generated inventory is not acceptance evidence or a substitute for actual behavior tests. Schema entries do not count as decoder implementations. Test names and opcode mentions include schema, shape and rejection tests; none are reported as passed by this audit.', '',
    `Original graph unique: **false**. ${report.originalGraph}`, '',
    '## Programmatic counts', '', '| Metric | Count |', '| --- | ---: |',
    ...Object.entries(counts).map(([key, value]) => `| ${key} | ${value} |`), '',
    '## Extraction rules', '', ...Object.entries(report.methodology).map(([key, value]) => `- **${key}**: ${value}`), '',
    '## Distinct opcode lists', ''];
  for (const [label, values] of [
    ['Direct IR input Scratch opcodes', directInput], ['Direct IR stack Scratch opcodes', directStack],
    ['Direct IR union', directUnion], ['Compatibility input entries', compatInput], ['Compatibility stack entries', compatStack],
    ['Compatibility/direct overlap', intersection(compatUnion, directUnion)],
    ['Explicit decoder source mentions', decoderOpcodes], ['Metadata/procedure helper source mentions (separate)', metadataOpcodes],
    ['Imported schema entries', schemaOpcodes], ['Schema entries without decoder string mention', report.recovery.schemaWithoutDecoderStringMention],
    ['Schema-only entries without decoder or metadata string mention', schemaOnly],
    ['Direct IR without decoder string mention (inventory gap, not an unsupported verdict)', report.gaps.directIRWithoutDecoderStringMention],
    ['Compatibility entries without schema', report.gaps.compatibilityWithoutSchema],
    ['Decoder mentions without explicit test-source mention', report.gaps.decoderMentionedWithoutTestSourceMention]
  ]) lines.push(`### ${label} (${values.length})`, '', values.length ? values.map(value => `\`${value}\``).join(', ') : '(none)', '');
  lines.push('## Procedures, warp, edge and runtime sources and gaps', '');
  for (const feature of features) {
    lines.push(`### ${feature.name}`, '', `Source evidence: ${evidenceText(feature.sources)}`, '',
      ...feature.gaps.map(gap => `- ${gap}`), '');
  }
  lines.push('## Test inventory (not executed)', '',
    'Names below are read from the current test files. Template names denote generated families, not individual executed cases. Compiler/runtime helper call presence is a syntactic clue, not a verified result; helpers or other runtime APIs may also be used.', '');
  for (const file of inventory) {
    lines.push(`### ${file.path}`, '', `sourceSha256: \`${file.sourceSha256}\``, '',
      ...file.testNames.map(entry => `- Line ${entry.line}: ${md(entry.name ?? entry.nameTemplate)}${entry.name === null ? ' (generated name template)' : ''}`), '');
  }
  lines.push('## Per-opcode inventory', '',
    'IR I/S = direct input/stack cases. Compat I/S = declared compatibility input/stack entries. Decoder/metadata/test flags indicate source mentions only. Semantic verification remains false for every row.', '',
    '| Opcode | IR I/S | Compat I/S | Schema | Decoder mention | Metadata mention | Test source mention | Tested |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...opcodes.map(entry => `| ${entry.opcode} | ${Number(entry.directIRInput)}/${Number(entry.directIRStack)} | ${Number(entry.compatibilityInputEntry)}/${Number(entry.compatibilityStackEntry)} | ${entry.schemaPresent} | ${entry.decoderSourceMentioned} | ${entry.metadataSourceMentioned} | ${entry.testSourceMentioned} | unknown |`), '',
    'Exact line evidence, IR enums/generator dispatch cases and full schema definitions are in coverage.json.', '',
    '## Source provenance', '', '| Source | SHA-256 |', '| --- | --- |',
    ...Object.entries(report.sourceSha256).map(([file, hash]) => `| ${file} | ${hash} |`), '');
  await fs.mkdir(outputDirectory, {recursive: true});
  const jsonPath = path.join(outputDirectory, 'coverage.json');
  const markdownPath = path.join(outputDirectory, 'coverage.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, `${lines.join('\n')}\n`);
  return {jsonPath, markdownPath, counts, semanticCoverageVerified: false, goalComplete: false, originalGraphUnique: false};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node factory/test/audit-recovery-coverage.mjs (optional FACTORY_02_VM_ROOT environment override)');
  console.log(JSON.stringify(await auditRecoveryCoverage(), null, 2));
}
