// 静态解包：仅提取和验证载荷，不运行页面或编译包中的 JavaScript。
// TurboWarp 旧格式移植自官方 unpackager（MPL-2.0）。
import JSZip from '@turbowarp/jszip';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tokenizer } from 'acorn';
import { decodeWithLengthHeaderCandidates, decodeWithoutLengthHeader, MAX_PROJECT_BYTES, validateLength } from './base85.mjs';
import { executableUnpack, isPE, isASAR } from './executable-unpack.mjs';

const MAX_ZIP_ENTRIES = 10000;
const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
export const STATIC_UNPACK_LIMITS = Object.freeze({
  inputBytes: MAX_PROJECT_BYTES, entries: MAX_ZIP_ENTRIES,
  entryBytes: MAX_ZIP_ENTRY_BYTES, totalBytes: MAX_ZIP_TOTAL_BYTES, jsonBytes: MAX_JSON_BYTES
});
const ZIP_DATE = new Date(1662869887000);
const utf8 = new TextDecoder('utf-8', { fatal: true });

const assertBytes = (data) => {
  if (!(data instanceof Uint8Array)) throw new Error('Expected Uint8Array project/container data');
  if (data.length > MAX_PROJECT_BYTES) throw new Error('Input exceeds container size limit');
};
const isZip = (data) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b &&
  ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6) || (data[2] === 7 && data[3] === 8));
export const isScratch1 = (data) => data.length >= 10 &&
  (Buffer.from(data.subarray(0, 10)).equals(Buffer.from('ScratchV01')) ||
   Buffer.from(data.subarray(0, 10)).equals(Buffer.from('ScratchV02')));

export const assertSafePath = (name) => {
  if (!name || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) ||
      name.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Unsafe ZIP/asset path: ${name}`);
  }
};

const unzipOrNull = async (data) => {
  assertBytes(data);
  if (!isZip(data)) return null;
  let zip;
  try {
    // 不恢复损坏 ZIP，也不在 loadAsync 内无限制地并行解压以检查 CRC。
    zip = await JSZip.loadAsync(data, { recoverCorrupted: false, checkCRC32: false });
  } catch (error) {
    throw new Error(`Invalid ZIP container: ${error.message}`);
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('ZIP entry count exceeds limit');
  let total = 0;
  for (const file of entries) {
    assertSafePath(file.unsafeOriginalName || file.name);
    assertSafePath(file.name);
    if (file.dir) continue;
    // JSZip 3.x 的压缩对象只解析目录，尚未解压。先检查声明尺寸。
    const size = file._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ZIP_ENTRY_BYTES) {
      throw new Error('ZIP entry size exceeds limit or is invalid');
    }
    total += size;
    if (total > MAX_ZIP_TOTAL_BYTES) throw new Error('ZIP total expanded size exceeds limit');
  }
  return zip;
};

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  return c >>> 0;
});
const crc32 = (data) => {
  let c = 0xffffffff;
  for (const byte of data) c = (c >>> 8) ^ crcTable[(c ^ byte) & 255];
  return (c ^ 0xffffffff) >>> 0;
};

const readZipFile = (file, limit = MAX_ZIP_ENTRY_BYTES) => {
  const compressed = file._data;
  const size = compressed?.uncompressedSize;
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('ZIP file size exceeds limit');
  let bytes;
  // 用 Node 自带 zlib 的硬输出上限，防止伪造 uncompressedSize 绕过边界。
  const method = compressed.compression?.magic;
  if (method === '\x00\x00') {
    bytes = new Uint8Array(compressed.compressedContent);
  } else if (method === '\x08\x00') {
    bytes = inflateRawSync(compressed.compressedContent, { maxOutputLength: Math.max(1, size) });
  } else {
    throw new Error('Unsupported ZIP compression');
  }
  if (bytes.length !== size) throw new Error('ZIP uncompressed length mismatch');
  if (crc32(bytes) !== (compressed.crc32 >>> 0)) throw new Error('ZIP CRC32 mismatch');
  return bytes;
};
const readZipText = (file) => utf8.decode(readZipFile(file, MAX_JSON_BYTES));

const identifyProjectJSONType = (json) => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid project.json object');
  const sb3 = Array.isArray(json.targets) && json.targets.every((target) => target && typeof target === 'object' && !Array.isArray(target));
  const sb2 = typeof json.objName === 'string';
  if (sb3 && !sb2) return 'sb3';
  if (sb2 && !('targets' in json)) return 'sb2';
  throw new Error('Can not determine project.json type (expected targets array or objName)');
};

const findFileInZip = (zip, path) => {
  const matches = Object.values(zip.files).filter((file) => !file.dir &&
    (file.name === path || file.name.endsWith(`/${path}`)));
  if (matches.length > 1) throw new Error(`Ambiguous ZIP: multiple ${path} files`);
  return matches[0] || null;
};
const siblingFile = (zip, file, path) => zip.file(file.name.slice(0, file.name.lastIndexOf('/') + 1) + path);
const zipToArrayBuffer = (zip) => zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

const normalizeProjectZip = async (zip, projectFile) => {
  const projectJSON = JSON.parse(readZipText(projectFile));
  const type = identifyProjectJSONType(projectJSON);
  const prefix = projectFile.name.slice(0, projectFile.name.lastIndexOf('/') + 1);
  const normalized = new JSZip();
  for (const file of Object.values(zip.files)) {
    // 不能使用 folder().files：JSZip 的 folder 视图仍共享整个 ZIP 的 files。
    if (!file.name.startsWith(prefix)) continue;
    const name = file.name.slice(prefix.length);
    if (!name) continue;
    assertSafePath(name);
    normalized.file(name, file.dir ? null : readZipFile(file), {
      dir: file.dir, date: ZIP_DATE, createFolders: false, comment: file.comment,
      unixPermissions: file.unixPermissions, dosPermissions: file.dosPermissions
    });
  }
  // 保留所选工程根目录内所有文件，包括字体、非三字母扩展和扩展附加数据。
  return { type, data: await zipToArrayBuffer(normalized), projectJSON };
};

const unpackageBinaryBlob = async (data) => {
  const zip = await unzipOrNull(data);
  if (zip) {
    const projectFile = findFileInZip(zip, 'project.json');
    if (!projectFile) throw new Error('Binary blob looks like a ZIP but has no project.json');
    return normalizeProjectZip(zip, projectFile);
  }
  if (isScratch1(data)) return { type: 'sb', data };
  throw new Error('Binary payload is neither a valid project ZIP nor ScratchV01/02 (Scratch1)');
};

const decodeBase64 = (str) => {
  if (typeof str !== 'string' || str.length > Math.ceil(MAX_PROJECT_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(str)) {
    throw new Error('Invalid or excessive base64 payload');
  }
  const bytes = new Uint8Array(Buffer.from(str, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== str) throw new Error('Invalid base64 padding');
  return bytes;
};
const decodeDataURI = (uri) => {
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]*)$/.exec(uri);
  if (!match) throw new Error('Data URI is not base64');
  return decodeBase64(match[1]);
};

// 静态 script 属性解析：支持单双引号、属性顺序、空白及 > 出现在引号内。
export const parseScripts = (text) => {
  const scripts = [];
  const tagRe = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of text.matchAll(tagRe)) {
    const attributes = Object.create(null);
    const attrRe = /([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g;
    for (const attr of match[1].matchAll(attrRe)) {
      const key = attr[1].toLowerCase();
      if (key in attributes) throw new Error(`Duplicate script attribute: ${key}`);
      attributes[key] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
    scripts.push({ attributes, body: match[2] });
  }
  return scripts;
};
export const getProjectChunks = (scripts, kind) => scripts.filter((script) => kind === 'o2'
  ? script.attributes.type?.toLowerCase() === 'application/x-o2-project-chunk'
  : 'data' in script.attributes && /^\s*decodeChunk\s*\(\s*\d+\s*\)\s*;?\s*$/.test(script.body)
).map((script) => {
  const rawLength = kind === 'o2' ? script.attributes['data-size'] : script.body.match(/\(\s*(\d+)\s*\)/)[1];
  if (typeof rawLength !== 'string' || !/^\d+$/.test(rawLength.trim())) throw new Error('Invalid chunk data-size');
  return { length: validateLength(Number(rawLength.trim())), payload: kind === 'o2' ? script.body.trim() : script.attributes.data };
});
export const getChunksLength = (chunks) => validateLength(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
const decodeChunks = (chunks) => {
  const result = new Uint8Array(getChunksLength(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    // 每块独立去掉自己的零 padding；奇数长度分块不能拼接编码字符串。
    result.set(decodeWithoutLengthHeader(chunk.payload, chunk.length), offset);
    offset += chunk.length;
  }
  return result;
};

const readJSLiteral = (literal) => {
  if (literal[0] === '"') return JSON.parse(literal);
  // 只处理静态字符串转义，不 eval；单双引号的 URI 编码均可解析。
  return literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, escape) => {
    if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[escape] ?? escape;
  });
};
const validateCompiledProject = (text) => {
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('compiledProject JSON exceeds size limit');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== '02engine-compiled-project') {
    throw new Error('Invalid compiledProject format (expected 02engine-compiled-project)');
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('Invalid compiledProject version (expected integer >= 1)');
  if (value.targets !== undefined && !Array.isArray(value.targets)) throw new Error('Invalid compiledProject targets');
  if (value.compiledTargets !== undefined && (!value.compiledTargets || typeof value.compiledTargets !== 'object' || Array.isArray(value.compiledTargets))) {
    throw new Error('Invalid compiledProject compiledTargets');
  }
  return value;
};

/** 与 identify 共用；提取所有静态 JSON.parse 候选，不能误取页面上第一个普通 JSON。 */
export const inspectCompiledProjectHTML = (text, scripts = parseScripts(text)) => {
  const warnings = [];
  const candidates = [];
  // 仅把加载调用当后备信号；库里的方法声明/格式比较字符串不是预编译载荷。
  let detected = /(?:\bscaffolding|\bvm)\s*\.\s*loadCompiledProject\s*\(/.test(text);
  // Repeated string alternatives in a RegExp exhaust V8's stack on large
  // compiled bundles. Scan quoted literals linearly, without evaluating them.
  const re = /JSON\s*\.\s*parse\s*\(\s*(decodeURIComponent\s*\(\s*)?/g;
  let match;
  while ((match = re.exec(text))) {
    const start = re.lastIndex;
    const quote = text[start];
    if (quote !== '"' && quote !== "'") continue;
    let end = start + 1;
    while (end < text.length && text[end] !== quote) {
      end += text[end] === '\\' ? 2 : 1;
    }
    if (end >= text.length) continue;
    re.lastIndex = ++end;
    const closing = match[1] ? /\s*\)\s*\)/y : /\s*\)/y;
    closing.lastIndex = end;
    if (!closing.test(text)) continue;
    let candidateText;
    try {
      candidateText = readJSLiteral(text.slice(start, end));
      if (match[1]) candidateText = decodeURIComponent(candidateText);
      if (candidateText.length > MAX_JSON_BYTES) throw new Error('compiledProject JSON exceeds size limit');
      const json = JSON.parse(candidateText);
      const schema = json && typeof json === 'object' && !Array.isArray(json) &&
        (json.format === '02engine-compiled-project' || ('compiledTargets' in json && 'targets' in json));
      if (!schema && !candidateText.includes('02engine-compiled-project')) continue;
      detected = true;
      validateCompiledProject(candidateText);
      candidates.push(candidateText);
    } catch (error) {
      const context = text.slice(Math.max(0, match.index - 80), match.index);
      if (candidateText?.includes('02engine-compiled-project') || /(?:projectData|compiledProject)\s*[:=]\s*$/.test(context)) {
        detected = true;
        warnings.push(`编译包未提取：${error.message}`);
      }
    }
  }
  // 兼容内嵌 application/json / compiled-project.json script 和 JSON data URI。
  for (const script of scripts) {
    if (!['application/json', 'application/x-o2-compiled-project'].includes(script.attributes.type?.toLowerCase())) continue;
    const body = script.body.trim();
    if (!body.includes('02engine-compiled-project') && !/compiled[-_]project/i.test(script.attributes.id || '')) continue;
    detected = true;
    try {
      validateCompiledProject(body);
      candidates.push(body);
    } catch (error) {
      warnings.push(`编译包未提取：${error.message}`);
    }
  }
  for (const match of text.matchAll(/data:application\/json(?:;charset=[^;,"'\s]+)?(?:;base64)?,([^"'\s<>]+)/gi)) {
    let candidateText;
    try {
      candidateText = /;base64,/i.test(match[0]) ? utf8.decode(decodeBase64(match[1])) : decodeURIComponent(match[1]);
      if (!candidateText.includes('02engine-compiled-project')) continue;
      detected = true;
      validateCompiledProject(candidateText);
      candidates.push(candidateText);
    } catch (error) {
      if (candidateText?.includes('02engine-compiled-project')) warnings.push(`编译包未提取：${error.message}`);
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length > 1) throw new Error('Ambiguous HTML: multiple compiledProject payloads');
  return { detected, compiledProject: unique[0], warnings };
};

const precompileResult = (format, inner, info, notes) => {
  const warnings = [...info.warnings];
  const metadata = { precompile: true, compiledProjectExtracted: !!info.compiledProject, sourceBlocksRecovered: false };
  if (inner.projectJSON?.targets) {
    const blocksPresent = inner.projectJSON.targets.some((target) => target.blocks && Object.keys(target.blocks).length > 0);
    metadata.projectBlocks = blocksPresent ? 'present' : 'empty';
    notes.push(blocksPresent
      ? '工程包中仍有 targets[].blocks；本步骤仅提取工程及编译 JSON'
      : '工程包中 targets[].blocks 为空；本步骤未反编译还原积木');
  }
  if (info.compiledProject) {
    const compiled = validateCompiledProject(info.compiledProject);
    metadata.compiledProjectVersion = compiled.version;
    notes.push('02Engine precompile：工程包及经验证的编译 JSON 已提取（不是积木还原成功）');
    if (!Array.isArray(compiled.targets) || !compiled.compiledTargets) warnings.push('编译 JSON 缺少 targets/compiledTargets 数据，未提取完整编译 bundle');
  } else {
    warnings.push('检测到 02Engine precompile，但编译包未提取；仅提取工程包，不能还原被剥离的积木');
  }
  notes.push(...warnings.map((warning) => `警告：${warning}`));
  return { format, type: inner.type, data: inner.data, notes, compiledProject: info.compiledProject, warnings, metadata };
};

const unpackageLengthHeader = async (payload) => {
  const valid = [];
  const errors = [];
  for (const candidate of decodeWithLengthHeaderCandidates(payload)) {
    try {
      valid.push({ candidate, inner: await unpackageBinaryBlob(candidate.data) });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!valid.length) throw new Error(`No valid project in base85 payload: ${errors.join('; ')}`);
  if (valid.length > 1 && !Buffer.from(valid[0].candidate.data).equals(Buffer.from(valid[1].candidate.data))) {
    throw new Error('Ambiguous base85 v1/v2: more than one valid project');
  }
  return valid[0].inner;
};

const buildHtmlifierZip = async (projectBytes, assets) => {
  const projectJSON = JSON.parse(utf8.decode(projectBytes));
  const type = identifyProjectJSONType(projectJSON);
  const zip = new JSZip();
  zip.file('project.json', projectBytes, { date: ZIP_DATE });
  if (Object.keys(assets).length > MAX_ZIP_ENTRIES) throw new Error('HTMLifier asset count exceeds limit');
  let total = projectBytes.length;
  for (const [name, uri] of Object.entries(assets)) {
    assertSafePath(name);
    if (name === 'project.json') throw new Error('Duplicate HTMLifier project.json');
    const bytes = decodeDataURI(uri);
    total += bytes.length;
    if (bytes.length > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) throw new Error('HTMLifier assets exceed size limit');
    zip.file(name, bytes, { date: ZIP_DATE });
  }
  return { type, data: await zipToArrayBuffer(zip) };
};

const EMBEDDED_LIMITS = Object.freeze({sources: 128, sourceBytes: MAX_JSON_BYTES,
  tokens: 1000000, candidates: 128, uriBytes: 8 * 1024 * 1024, decodedBytes: 16 * 1024 * 1024});
const embeddedHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const extensionCall = ['.', 'extensionManager', '.', 'loadExtensionURL', '('];
const tokenIs = (token, expected) => token && (token.type.label === expected ||
  token.type.label === 'name' && token.value === expected);

// Tokenize, never evaluate: comments/string contents cannot masquerade as API
// calls. Only the literal TW/O2 for-of template or a direct literal call proves
// where a URI was used; neither proves an extension ID or original URL.
const inspectEmbeddedSource = (text, source, state) => {
  if (!text.includes('loadExtensionURL')) return;
  const input = tokenizer(text, {ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true});
  const pending = [];
  const peek = (index = 0) => {
    while (pending.length <= index) {
      if (++state.tokens > EMBEDDED_LIMITS.tokens) throw new Error('embedded extension token limit exceeded');
      pending.push(input.getToken());
    }
    return pending[index];
  };
  const take = () => { const token = peek(); pending.shift(); return token; };
  const matches = (offset, sequence) => sequence.every((expected, index) => tokenIs(peek(offset + index), expected));
  const capture = (uri, offset, arrayIndex = null) => {
    if (++state.candidates > EMBEDDED_LIMITS.candidates) throw new Error('embedded extension candidate limit exceeded');
    const comma = uri.indexOf(',');
    const header = uri.slice(0, comma).toLowerCase();
    if (comma < 0 || !/^data:(?:text|application)\/(?:javascript|ecmascript)(?:;[^,]*)?$/.test(header)) {
      state.warnings.add('External/dynamic extension dependency not captured as embedded JavaScript');
      return;
    }
    if (Buffer.byteLength(uri) > EMBEDDED_LIMITS.uriBytes) throw new Error('embedded extension URI size limit exceeded');
    let bytes;
    try {
      if (/;base64(?:;|$)/.test(header)) {
        const payload = uri.slice(comma + 1);
        bytes = Buffer.from(payload, 'base64');
        if (bytes.toString('base64') !== payload) throw new Error('Invalid base64 padding/alphabet');
      } else {
        bytes = Buffer.from(decodeURIComponent(uri.slice(comma + 1)), 'utf8');
      }
    } catch (error) {
      state.warnings.add(`Embedded extension URI could not be decoded: ${error.message}`);
      return;
    }
    const sha256 = embeddedHash(bytes);
    let record = state.records.get(sha256);
    if (!record) {
      state.decodedBytes += bytes.length;
      if (state.decodedBytes > EMBEDDED_LIMITS.decodedBytes) throw new Error('embedded extension decoded size limit exceeded');
      record = {sha256, bytes, evidence: []};
      state.records.set(sha256, record);
    }
    record.evidence.push({source, offset, arrayIndex, api: 'vm.extensionManager.loadExtensionURL',
      uriSha256: embeddedHash(uri), association: 'unproven'});
  };
  try {
    while (!tokenIs(peek(), 'eof')) {
      const token = take();
      if (tokenIs(token, 'for') && matches(0, ['(', 'const', 'extension', 'of', '['])) {
        let at = 5;
        const urls = [];
        while (!tokenIs(peek(at), ']') && urls.length <= EMBEDDED_LIMITS.candidates) {
          if (peek(at).type.label !== 'string') break;
          urls.push(peek(at++).value);
          if (!tokenIs(peek(at), ',')) break;
          at++;
        }
        if (urls.length > EMBEDDED_LIMITS.candidates) throw new Error('embedded extension candidate limit exceeded');
        if (matches(at, [']', ')', '{', 'vm', ...extensionCall, 'extension', ')', ';', '}'])) {
          urls.forEach((uri, index) => capture(uri, token.start, index));
          for (let i = 0; i < at + 13; i++) take();
          continue;
        }
      }
      if (tokenIs(token, 'vm') && matches(0, extensionCall)) {
        const argument = peek(extensionCall.length);
        if (argument.type.label === 'string' && tokenIs(peek(extensionCall.length + 1), ')')) {
          capture(argument.value, token.start);
        } else {
          state.warnings.add('Dynamic extension dependency: association unproven; auto loading not restored');
        }
      }
    }
  } catch (error) {
    state.warnings.add(`Embedded extension inspection incomplete (${source}): ${error.message}`);
  }
};

const preserveEmbedded = async (result, sources, initialWarnings = []) => {
  if (result.type !== 'sb3') return result;
  const state = {records: new Map(), warnings: new Set(initialWarnings), candidates: 0, decodedBytes: 0, tokens: 0};
  let sourceBytes = 0;
  for (const [index, {text, source}] of sources.entries()) {
    sourceBytes += Buffer.byteLength(text);
    if (index >= EMBEDDED_LIMITS.sources || sourceBytes > EMBEDDED_LIMITS.sourceBytes) {
      state.warnings.add('Embedded extension inspection incomplete: source count/size limit exceeded');
      break;
    }
    inspectEmbeddedSource(text, source, state);
    if (state.candidates > EMBEDDED_LIMITS.candidates || state.decodedBytes > EMBEDDED_LIMITS.decodedBytes ||
        state.tokens > EMBEDDED_LIMITS.tokens) break;
  }
  if (!state.records.size && !state.warnings.size) return result;
  state.warnings.add('Embedded extension association unproven; auto loading not restored; full offline dependency availability is not verified');
  const warnings = [...state.warnings];
  let data = result.data;
  let manifestPath = null;
  if (state.records.size) {
    const zip = await unzipOrNull(data);
    const names = Object.keys(zip.files);
    let expandedBytes = Object.values(zip.files).reduce((sum, file) => sum + (file.dir ? 0 : file._data.uncompressedSize), 0);
    let prefix = '.factory-embedded';
    for (let suffix = 2; names.some(name => name === prefix || name.startsWith(prefix + '/')); suffix++) {
      if (suffix > MAX_ZIP_ENTRIES + 1) throw new Error('No free embedded dependency namespace');
      prefix = `.factory-embedded-${suffix}`;
    }
    if (names.length + state.records.size + 1 > MAX_ZIP_ENTRIES) throw new Error('Embedded supplemental files exceed ZIP entry count limit');
    const records = [];
    for (const record of state.records.values()) {
      const path = `${prefix}/extensions/${record.sha256}.js.txt`;
      expandedBytes += record.bytes.length;
      if (expandedBytes > MAX_ZIP_TOTAL_BYTES) throw new Error('Embedded supplemental bytes exceed ZIP total size limit');
      // A text supplement, not an extension URL: never auto-load recovered code.
      zip.file(path, record.bytes, {date: ZIP_DATE, createFolders: false});
      records.push({path, sha256: record.sha256, bytes: record.bytes.length, evidence: record.evidence,
        association: 'unproven', autoLoadingRestored: false});
    }
    manifestPath = `${prefix}/manifest.json`;
    const manifest = JSON.stringify({schemaVersion: 1, kind: 'embedded-extension-supplement',
      executesInput: false, offlineDependenciesVerified: false, warnings, records}, null, 2);
    if (expandedBytes + Buffer.byteLength(manifest) > MAX_ZIP_TOTAL_BYTES) throw new Error('Embedded manifest exceeds ZIP total size limit');
    zip.file(manifestPath, manifest, {date: ZIP_DATE, createFolders: false});
    data = await zipToArrayBuffer(zip);
  }
  return {...result, data, warnings: [...(result.warnings || []), ...warnings],
    notes: [...(result.notes || []), ...warnings.map(warning => `Warning: ${warning}`)],
    metadata: {...result.metadata, embeddedDependencies: {executesInput: false, association: 'unproven',
      autoLoadingRestored: false, offlineDependenciesVerified: false, manifestPath, captured: state.records.size}}};
};
const htmlSources = (scripts, source) => scripts.flatMap((script, index) =>
  !script.attributes.src && (!script.attributes.type ||
    ['text/javascript', 'application/javascript', 'module'].includes(script.attributes.type.toLowerCase()))
    ? [{text: script.body, source: `${source}#script[${index}]`}] : []);
const preserveZipEmbedded = async (result, zip) => {
  const sources = [];
  const warnings = [];
  let bytes = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/\.(?:js|mjs|html?)$/i.test(file.name)) continue;
    bytes += file._data.uncompressedSize;
    if (sources.length >= EMBEDDED_LIMITS.sources || bytes > EMBEDDED_LIMITS.sourceBytes) {
      warnings.push('Embedded extension inspection incomplete: package source count/size limit exceeded');
      break;
    }
    try {
      const text = readZipText(file);
      sources.push(...(/\.html?$/i.test(file.name) ? htmlSources(parseScripts(text), file.name) : [{text, source: file.name}]));
    } catch (error) {
      warnings.push(`Embedded extension inspection incomplete (${file.name}): ${error.message}`);
    }
  }
  return preserveEmbedded(result, sources, warnings);
};

/** 保持 type/data/format/notes/compiledProject 返回字段；预编译附带 warnings/metadata。 */
export const staticUnpack = async (data) => {
  assertBytes(data);
  if (isPE(data) || isASAR(data)) {
    return executableUnpack(data, {
      limits: STATIC_UNPACK_LIMITS, safePath: assertSafePath, unpack: staticUnpack,
      readZipEntries: async (bytes, expectedEntries) => {
        const zip = await unzipOrNull(bytes);
        if (!zip) throw new Error('Invalid carved ZIP signature');
        if (Object.keys(zip.files).length !== expectedEntries) throw new Error('ZIP decoded entry count mismatch');
        return Object.values(zip.files).filter((file) => !file.dir)
          .map((file) => ({ name: file.name, bytes: readZipFile(file) }));
      }
    });
  }
  const notes = [];
  const zip = await unzipOrNull(data);
  if (zip) {
    const projectFile = findFileInZip(zip, 'project.json');
    const compiledFile = findFileInZip(zip, 'compiled-project.json');
    if (compiledFile) {
      const compiledProject = readZipText(compiledFile);
      validateCompiledProject(compiledProject);
      const projectBinary = siblingFile(zip, compiledFile, 'project.zip') || siblingFile(zip, compiledFile, 'project');
      let inner;
      if (projectFile) inner = await normalizeProjectZip(zip, projectFile);
      else if (projectBinary) inner = await unpackageBinaryBlob(readZipFile(projectBinary));
      else throw new Error('02Engine precompile ZIP: compiledProject found, but no project archive was extracted');
      return preserveZipEmbedded(precompileResult('o2-zip-precompile', inner, { compiledProject, warnings: [] }, notes), zip);
    }
    if (projectFile) {
      const inner = await normalizeProjectZip(zip, projectFile);
      notes.push('zip 容器：按 project.json 判定类型并归一化工程根目录，保留根目录内全部资产和附加数据');
      return preserveZipEmbedded({ format: `zip-${inner.type}`, type: inner.type, data: inner.data, notes }, zip);
    }
    const projectBinary = findFileInZip(zip, 'project.zip') || findFileInZip(zip, 'project');
    if (projectBinary) {
      const inner = await unpackageBinaryBlob(readZipFile(projectBinary));
      notes.push('zip 容器：内嵌工程已验证并提取');
      return preserveZipEmbedded({ format: 'zip-inner', type: inner.type, data: inner.data, notes }, zip);
    }
    throw new Error('Input was a ZIP but we could not find a project.');
  }
  if (isScratch1(data)) return { format: 'scratch1-binary', type: 'sb', data, notes };

  const text = new TextDecoder().decode(data);
  const scripts = parseScripts(text);
  const finishHTML = result => preserveEmbedded(result, htmlSources(scripts, 'input.html'));
  const o2Chunks = getProjectChunks(scripts, 'o2');
  if (o2Chunks.length) {
    const inner = await unpackageBinaryBlob(decodeChunks(o2Chunks));
    const info = inspectCompiledProjectHTML(text, scripts);
    if (info.detected) return finishHTML(precompileResult('o2-html-precompile', inner, info, notes));
    return finishHTML({ format: 'o2-html-chunk', type: inner.type, data: inner.data, notes });
  }
  const twChunks = getProjectChunks(scripts, 'tw');
  if (twChunks.length) {
    const inner = await unpackageBinaryBlob(decodeChunks(twChunks));
    return finishHTML({ format: 'tw-html-chunk-v4', type: inner.type, data: inner.data, notes });
  }

  // p4-project 在旧格式中是同一个带长度头字符串的片段，而非独立编码块。
  const p4Scripts = scripts.filter((script) => script.attributes.type === 'p4-project');
  if (p4Scripts.length) {
    const inner = await unpackageLengthHeader(p4Scripts.map((script) => script.body).join('').trim());
    return finishHTML({ format: 'tw-html-p4-project', type: inner.type, data: inner.data, notes });
  }
  const encodedScript = scripts.find((script) => script.attributes.id === 'p4-encoded-project-data');
  const encodedMatch = text.match(/const\s+result\s*=\s*base85decode\("([^"\r\n]*)"\)\s*;/);
  if (encodedScript || encodedMatch) {
    const inner = await unpackageLengthHeader(encodedScript ? encodedScript.body.trim() : encodedMatch[1]);
    return finishHTML({ format: 'tw-html-p4-encoded', type: inner.type, data: inner.data, notes });
  }

  const dataURIMatch =
    text.match(/const getProjectData = \(\) => fetch\("([a-zA-Z0-9+/=\-:;,]+)"\)/) ||
    text.match(/var project = '([a-zA-Z0-9+/=\-:;,]+)';/) ||
    text.match(/window\.__PACKAGER__ = {\n    projectData: "([a-zA-Z0-9+/=\-:;,]+)"/) ||
    text.match(/^FILE = "(data:application\/octet-stream;base64,[a-zA-Z0-9+/=]+)",$/m);
  if (dataURIMatch) {
    const inner = await unpackageBinaryBlob(decodeDataURI(dataURIMatch[1]));
    const format = dataURIMatch[0].startsWith('var project') ? 'forkphorus-html-base64' :
      dataURIMatch[0].startsWith('window.__PACKAGER__') ? 'tw-legacy-html-base64' : 'tw-html-base64';
    return finishHTML({ format, type: inner.type, data: inner.data, notes });
  }

  let htmlifierOptions = text.match(/<script>\nconst GENERATED = \d+\nconst initOptions = ({[\s\S]+})\ninit\(initOptions\)\n<\/script>/m);
  if (htmlifierOptions) {
    const assets = JSON.parse(htmlifierOptions[1]).assets;
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw new Error('Invalid HTMLifier assets');
    if (assets.file) {
      const inner = await unpackageBinaryBlob(decodeDataURI(assets.file));
      return finishHTML({ format: 'htmlifier-initoptions', type: inner.type, data: inner.data, notes });
    }
    const { project, ...otherAssets } = assets;
    const inner = await buildHtmlifierZip(decodeDataURI(project), otherAssets);
    return finishHTML({ format: 'htmlifier-initoptions', ...inner, notes: ['HTMLifier 资产散表已验证并重组'] });
  }
  htmlifierOptions = text.match(/var TYPE = 'json',\nPROJECT_JSON = "([^"]*)",\nASSETS = ({[^}]*}),/m);
  if (htmlifierOptions) {
    const inner = await buildHtmlifierZip(decodeDataURI(htmlifierOptions[1]), JSON.parse(htmlifierOptions[2]));
    return finishHTML({ format: 'htmlifier-type-json', ...inner, notes: ['HTMLifier 旧版散表已验证并重组'] });
  }

  if (text.includes('<script src="script.js"></script>')) {
    throw new Error('这是 zip 打包环境的 HTML，单独一份 HTML 无法解出工程；请提供完整 zip 包（内含 project.zip/script.js）。');
  }
  if (text.includes('<style class="scratch-render-styles"') || text.includes('<div class="sc-layers"') ||
      text.includes('<canvas class="sc-canvas"') || text.includes('<div class="scratch-render-overlays"') ||
      text.includes('<div class="sc-monitor-overlay"')) {
    throw new Error('疑似工程加载后另存的 HTML：数据已在加载时从页面移除，无法还原。');
  }
  throw new Error('无法识别的容器格式（既不是 zip/Scratch1 也没有可识别的工程数据指纹）。');
};
