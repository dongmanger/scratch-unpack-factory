// Bounded, read-only PE-overlay ZIP / standalone Electron ASAR extraction.
// No executable code, filesystem reads, archive recovery, or decryption.
import JSZip from '@turbowarp/jszip';
import { createHash } from 'node:crypto';

export const MAX_EXECUTABLE_CANDIDATES = 4;
export const MAX_EOCD_SIGNATURES = 32;
const MAX_ASAR_DEPTH = 128;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const bytesBuffer = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
const viewOf = (data) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };
const boundedInput = (data, limits) => {
  if (!(data instanceof Uint8Array)) fail('Expected Uint8Array executable/container data');
  if (data.length > limits.inputBytes) fail('Input exceeds container size limit');
};
export const isPE = (data) => data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a;
// ASAR has no magic; this is only the Chromium size-pickle fingerprint.
export const isASAR = (data) => data.length >= 4 && viewOf(data).getUint32(0, true) === 4;

export const inspectPE = (data) => {
  if (!isPE(data) || data.length < 64) fail('Invalid or truncated PE DOS header');
  const v = viewOf(data);
  const peOffset = v.getUint32(60, true);
  if (peOffset < 64 || peOffset + 24 > data.length || v.getUint32(peOffset, true) !== 0x00004550) {
    fail('Invalid or truncated PE signature/COFF header');
  }
  const sectionCount = v.getUint16(peOffset + 6, true);
  const optionalSize = v.getUint16(peOffset + 20, true);
  const optional = peOffset + 24;
  const sections = optional + optionalSize;
  if (!sectionCount || sectionCount > 96 || optionalSize < 64 || sections + sectionCount * 40 > data.length) {
    fail('Invalid or truncated PE optional header/section table');
  }
  const magic = v.getUint16(optional, true);
  const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  if (!directories || optionalSize < directories) fail('Unsupported PE optional header');
  const headerSize = v.getUint32(optional + 60, true);
  if (headerSize < sections + sectionCount * 40 || headerSize > data.length) fail('Invalid PE SizeOfHeaders');
  let overlayOffset = headerSize;
  const ranges = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = sections + i * 40;
    const size = v.getUint32(at + 16, true);
    const offset = v.getUint32(at + 20, true);
    if (!size) continue;
    if (offset < headerSize || offset + size > data.length) fail('Invalid or truncated PE section range');
    ranges.push({ offset, end: offset + size });
    overlayOffset = Math.max(overlayOffset, offset + size);
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].end) fail('Overlapping PE sections');
  const directoryCount = v.getUint32(optional + directories - 4, true);
  if (directories + directoryCount * 8 > optionalSize) fail('Invalid PE data directory bounds');
  // The certificate directory uses file offsets, unlike other PE directories.
  if (directoryCount > 4) {
    const certificateOffset = v.getUint32(optional + directories + 32, true);
    const certificateSize = v.getUint32(optional + directories + 36, true);
    if (certificateOffset || certificateSize) {
      if (!certificateOffset || !certificateSize || certificateOffset < overlayOffset ||
          certificateOffset + certificateSize > data.length) fail('Invalid PE certificate range');
      overlayOffset = certificateOffset + certificateSize;
    }
  }
  return { peOffset, sectionCount, overlayOffset };
};

const checkExtra = (v, start, size) => {
  const end = start + size;
  while (start < end) {
    if (start + 4 > end) fail('Invalid ZIP extra field bounds');
    const id = v.getUint16(start, true);
    const length = v.getUint16(start + 2, true);
    start += 4;
    if (start + length > end) fail('Invalid ZIP extra field length');
    if (id === 1) fail('ZIP64 executable overlays are unsupported');
    start += length;
  }
};

// Derive archive start from EOCD, never from a first PK signature. Validate every
// directory/local record before JSZip sees the carved bytes (it tolerates some
// directory count mismatches even with recoverCorrupted:false).
const inspectZipCandidate = (data, eocd, overlayOffset, limits, safePath) => {
  const v = viewOf(data);
  const records = v.getUint16(eocd + 10, true);
  const centralSize = v.getUint32(eocd + 12, true);
  const centralOffset = v.getUint32(eocd + 16, true);
  const end = eocd + 22 + v.getUint16(eocd + 20, true);
  if (end > data.length) fail('Truncated ZIP EOCD comment');
  if (v.getUint16(eocd + 4, true) || v.getUint16(eocd + 6, true) || v.getUint16(eocd + 8, true) !== records) {
    fail('Invalid or unsupported multi-disk ZIP EOCD');
  }
  if (records === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 executable overlays are unsupported');
  if (!records || records > limits.entries) fail('ZIP entry count exceeds limit or is empty');
  const start = eocd - centralSize - centralOffset;
  const centralStart = eocd - centralSize;
  if (start < overlayOffset || centralOffset < 30 || centralSize < 46 || centralStart < start ||
      v.getUint32(start, true) !== 0x04034b50) fail('Invalid appended ZIP start/central directory bounds');
  let at = centralStart;
  let total = 0;
  const names = new Set();
  const ranges = [];
  for (let i = 0; i < records; i++) {
    if (at + 46 > eocd || v.getUint32(at, true) !== 0x02014b50) fail('Invalid ZIP central directory record/count');
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const compressed = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    const localOffset = v.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || !nameLength) fail('Invalid ZIP central name/extra/comment bounds');
    if (v.getUint16(at + 34, true)) fail('Unsupported multi-disk ZIP entry');
    if (flags & ~0x080e || (method !== 0 && method !== 8)) fail('Unsupported ZIP encryption/flags/compression');
    if (size > limits.entryBytes || compressed === 0xffffffff || localOffset === 0xffffffff) fail('ZIP entry size exceeds limit or ZIP64 is unsupported');
    total += size;
    if (total > limits.totalBytes) fail('ZIP total expanded size exceeds limit');
    const rawName = data.subarray(at + 46, at + 46 + nameLength);
    const name = utf8.decode(rawName);
    safePath(name);
    if (names.has(name)) fail(`Duplicate ZIP entry: ${name}`);
    names.add(name);
    if ((v.getUint32(at + 38, true) >>> 16 & 0xf000) === 0xa000) fail('ZIP symlinks are unsupported');
    checkExtra(v, at + 46 + nameLength, extraLength);
    const local = start + localOffset;
    if (local < start || local + 30 > centralStart || v.getUint32(local, true) !== 0x04034b50) fail('Invalid ZIP local header offset');
    const localNameLength = v.getUint16(local + 26, true);
    const localExtraLength = v.getUint16(local + 28, true);
    const content = local + 30 + localNameLength + localExtraLength;
    if (content + compressed > centralStart || localNameLength !== nameLength ||
        !bytesBuffer(rawName).equals(bytesBuffer(data.subarray(local + 30, local + 30 + localNameLength))) ||
        v.getUint16(local + 6, true) !== flags || v.getUint16(local + 8, true) !== method) {
      fail('ZIP local/central header mismatch or invalid content bounds');
    }
    checkExtra(v, local + 30 + localNameLength, localExtraLength);
    let rangeEnd = content + compressed;
    const crcAt = flags & 8 ? rangeEnd + (rangeEnd + 4 <= centralStart && v.getUint32(rangeEnd, true) === 0x08074b50 ? 4 : 0) : local + 14;
    if (crcAt + 12 > centralStart || v.getUint32(crcAt, true) !== crc ||
        v.getUint32(crcAt + 4, true) !== compressed || v.getUint32(crcAt + 8, true) !== size) {
      fail('ZIP local header/data descriptor CRC or size mismatch');
    }
    if (flags & 8) rangeEnd = crcAt + 12;
    ranges.push({ offset: local, end: rangeEnd, contentOffset: content, contentEnd: content + compressed });
    at = next;
  }
  if (at !== eocd) fail('ZIP central directory size/count mismatch');
  ranges.sort((a, b) => a.offset - b.offset);
  let previous = start;
  for (const range of ranges) {
    if (range.offset !== previous) fail('ZIP local records overlap or contain unaccounted bytes');
    previous = range.end;
  }
  if (previous !== centralStart) fail('ZIP local data/central directory gap');
  return { start, end, eocd, entries: records, expandedBytes: total,
    contentRanges: ranges.map((range) => ({ start: range.contentOffset, end: range.contentEnd })) };
};

export const scanPEZipCandidates = (data, { limits, safePath }) => {
  boundedInput(data, limits);
  const pe = inspectPE(data);
  const buffer = bytesBuffer(data);
  const signature = Buffer.from([0x50, 0x4b, 5, 6]);
  const candidates = [];
  const rejected = [];
  let signatures = 0;
  for (let at = buffer.indexOf(signature, pe.overlayOffset); at !== -1; at = buffer.indexOf(signature, at + 4)) {
    if (++signatures > MAX_EOCD_SIGNATURES) fail('Executable ZIP EOCD signature scan limit exceeded');
    if (at + 22 > data.length) { rejected.push({ offset: at, error: 'Truncated ZIP EOCD' }); continue; }
    try {
      candidates.push(inspectZipCandidate(data, at, pe.overlayOffset, limits, safePath));
    } catch (error) {
      const v = viewOf(data);
      const centralStart = at - v.getUint32(at + 12, true);
      const start = centralStart - v.getUint32(at + 16, true);
      const end = at + 22 + v.getUint16(at + 20, true);
      const archiveLike = start >= pe.overlayOffset && start + 30 <= centralStart && centralStart + 46 <= at &&
        v.getUint32(start, true) === 0x04034b50 && v.getUint32(centralStart, true) === 0x02014b50;
      rejected.push({ offset: at, error: error.message, ...(archiveLike ? { start, end, archiveLike: true } : {}) });
    }
    if (candidates.length > MAX_EXECUTABLE_CANDIDATES) fail('Executable ZIP candidate count exceeds limit');
  }
  // A stored project.zip can itself have fully valid ZIP records. It is a
  // payload if its complete byte range is inside a validated outer file.
  const outer = candidates.filter((candidate) => !candidates.some((container) =>
    container !== candidate && container.contentRanges.some((range) =>
      candidate.start >= range.start && candidate.end <= range.end)));
  return { ...pe, signatures, candidates: outer.map(({ contentRanges, ...candidate }) => candidate), rejected };
};

// JSON.parse accepts duplicate keys. Reject them instead of silently dropping
// a header entry. JSON syntax is checked first; this scan only tracks key sets.
const parseHeaderJSON = (text) => {
  const header = JSON.parse(text);
  const stack = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const value = token[0];
    const top = stack.at(-1);
    if (value === '{') stack.push({ keys: new Set(), key: true });
    else if (value === '[') stack.push({});
    else if (value === '}' || value === ']') stack.pop();
    else if (value === ',' && top?.keys) top.key = true;
    else if (value[0] === '"' && top?.keys && top.key) {
      const key = JSON.parse(value);
      if (top.keys.has(key)) fail(`Duplicate ASAR header key: ${key}`);
      top.keys.add(key);
      top.key = false;
    }
    if (stack.length > MAX_ASAR_DEPTH + 4) fail('ASAR header nesting exceeds limit');
  }
  return header;
};

const checkIntegrity = (bytes, integrity, path) => {
  if (integrity === undefined) return;
  if (!object(integrity) || integrity.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/i.test(integrity.hash || '') ||
      !Number.isSafeInteger(integrity.blockSize) || integrity.blockSize < 1 || !Array.isArray(integrity.blocks) ||
      integrity.blocks.length !== Math.ceil(bytes.length / integrity.blockSize) ||
      integrity.blocks.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))) fail(`Invalid ASAR integrity metadata: ${path}`);
  const hash = (part) => createHash('sha256').update(part).digest('hex');
  if (hash(bytes) !== integrity.hash.toLowerCase()) fail(`ASAR integrity hash mismatch: ${path}`);
  for (let i = 0; i < integrity.blocks.length; i++) {
    if (hash(bytes.subarray(i * integrity.blockSize, (i + 1) * integrity.blockSize)) !== integrity.blocks[i].toLowerCase()) {
      fail(`ASAR integrity block mismatch: ${path}`);
    }
  }
};

export const readASAR = (data, { limits, safePath }) => {
  boundedInput(data, limits);
  if (!isASAR(data) || data.length < 16) fail('Invalid or truncated ASAR size/header pickle');
  const v = viewOf(data);
  const headerSize = v.getUint32(4, true);
  const payloadSize = v.getUint32(8, true);
  const jsonSize = v.getUint32(12, true);
  if (!jsonSize || jsonSize > limits.jsonBytes || headerSize > limits.jsonBytes + 11) fail('ASAR header size exceeds limit or is invalid');
  if (payloadSize !== 4 + Math.ceil(jsonSize / 4) * 4 || headerSize !== payloadSize + 4 || 8 + headerSize > data.length) {
    fail('Invalid or truncated ASAR pickle/header bounds');
  }
  const dataOffset = 8 + headerSize;
  if (data.subarray(16 + jsonSize, dataOffset).some((byte) => byte !== 0)) fail('Invalid ASAR pickle padding');
  const header = parseHeaderJSON(utf8.decode(data.subarray(16, 16 + jsonSize)));
  if (!object(header) || !object(header.files)) fail('Invalid ASAR root files object');
  const entries = [];
  const missingExternalAssets = [];
  const ranges = [];
  let count = 0;
  let total = 0;
  const pending = [{ files: header.files, prefix: '', depth: 0, unpacked: false }];
  while (pending.length) {
    const directory = pending.pop();
    if (directory.depth > MAX_ASAR_DEPTH) fail('ASAR directory depth exceeds limit');
    for (const [name, node] of Object.entries(directory.files)) {
      if (++count > limits.entries) fail('ASAR entry count exceeds limit');
      if (!name || name.includes('/') || name.includes(':')) fail(`Unsafe ASAR path component: ${name}`);
      const path = directory.prefix + name;
      safePath(path);
      if (!object(node)) fail(`Invalid ASAR entry: ${path}`);
      if ('link' in node) fail(`ASAR links are unsupported: ${path}`);
      if ('unpacked' in node && typeof node.unpacked !== 'boolean') fail(`Invalid ASAR unpacked flag: ${path}`);
      const unpacked = directory.unpacked || node.unpacked === true;
      if ('files' in node) {
        if (!object(node.files) || 'size' in node || 'offset' in node) fail(`Invalid ASAR directory: ${path}`);
        pending.push({ files: node.files, prefix: path + '/', depth: directory.depth + 1, unpacked });
        continue;
      }
      if (!Number.isSafeInteger(node.size) || node.size < 0 || node.size > limits.entryBytes) fail(`ASAR entry size exceeds limit or is invalid: ${path}`);
      total += node.size;
      if (total > limits.totalBytes) fail('ASAR total file size exceeds limit');
      if (unpacked) {
        if ('offset' in node) fail(`Invalid ASAR unpacked entry has packed offset: ${path}`);
        missingExternalAssets.push({ path, size: node.size });
        continue;
      }
      if (typeof node.offset !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(node.offset)) fail(`Invalid ASAR file offset: ${path}`);
      const offset = Number(node.offset);
      if (!Number.isSafeInteger(offset) || offset > data.length - dataOffset || node.size > data.length - dataOffset - offset) fail(`ASAR file offset/size out of bounds: ${path}`);
      const bytes = data.subarray(dataOffset + offset, dataOffset + offset + node.size);
      checkIntegrity(bytes, node.integrity, path);
      if (node.size) ranges.push({ offset, end: offset + node.size });
      entries.push({ name: path, bytes });
    }
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].end) fail('Overlapping ASAR packed file ranges');
  return { entries, missingExternalAssets, headerBytes: headerSize, dataOffset, entryCount: count, totalBytes: total };
};

const missingError = (missing) => {
  const error = new Error(`Missing external ASAR unpacked assets (${missing.length}): ${missing.slice(0, 8).map((file) => file.path).join(', ')}; a standalone ASAR cannot supply .asar.unpacked files`);
  error.code = 'ASAR_MISSING_UNPACKED';
  error.missingExternalAssets = missing;
  return error;
};
const isProjectFile = (name) => /(?:^|\/)(?:project\.json|project\.zip|project|compiled-project\.json)$/.test(name);
const htmlFingerprint = (bytes) => /application\/x-o2-project-chunk|\bdecodeChunk\s*\(|p4-project|p4-encoded-project-data|\bbase85decode\s*\(|getProjectData\s*=|var project = 'data:|window\.__PACKAGER__|^FILE = "data:|const GENERATED = \d+|var TYPE = 'json'/m.test(utf8.decode(bytes));

const validateNestedProjectZip = (bytes, limits, safePath) => {
  if (bytes.length < 4 || viewOf(bytes).getUint32(0, true) !== 0x04034b50) return;
  const buffer = bytesBuffer(bytes);
  const signature = Buffer.from([0x50, 0x4b, 5, 6]);
  let signatures = 0;
  const candidates = [];
  const errors = [];
  // A complete standalone ZIP EOCD must be within the final 65557 bytes.
  for (let at = buffer.indexOf(signature, Math.max(0, bytes.length - 65557)); at !== -1; at = buffer.indexOf(signature, at + 4)) {
    if (++signatures > MAX_EOCD_SIGNATURES) fail('Nested project ZIP EOCD signature limit exceeded');
    if (at + 22 > bytes.length || at + 22 + viewOf(bytes).getUint16(at + 20, true) !== bytes.length) continue;
    try {
      const candidate = inspectZipCandidate(bytes, at, 0, limits, safePath);
      if (candidate.start !== 0) fail('Nested project ZIP has unaccounted prefix bytes');
      candidates.push(candidate);
    } catch (error) { errors.push(error.message); }
  }
  if (candidates.length !== 1) fail(`Invalid or ambiguous nested project ZIP: ${errors.join('; ') || 'missing complete EOCD'}`);
};

const unpackEntries = async (entries, unpack, limits, archive, safePath) => {
  for (const file of entries) {
    if (/(?:^|\/)(?:project\.zip|project)$/.test(file.name)) validateNestedProjectZip(file.bytes, limits, safePath);
  }
  if (entries.some((file) => isProjectFile(file.name))) {
    if (archive) return { inner: await unpack(archive), source: 'ZIP project files' };
    // Reuse existing project-root, project.zip and compiled-project validation.
    // STORE avoids spending CPU recompressing an ASAR before project validation.
    const zip = new JSZip();
    let bytes = 22;
    for (const file of entries) {
      bytes += file.bytes.length + 76 + 2 * Buffer.byteLength(file.name);
      if (bytes > limits.inputBytes) fail('ASAR project ZIP normalization exceeds container size limit');
      zip.file(file.name, file.bytes, { createFolders: false, date: new Date(1662869887000) });
    }
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    if (data.length > limits.inputBytes) fail('ASAR project ZIP normalization exceeds container size limit');
    return { inner: await unpack(data), source: 'ASAR project files' };
  }
  const html = entries.filter((file) => /\.html?$/i.test(file.name) && htmlFingerprint(file.bytes));
  if (html.length > MAX_EXECUTABLE_CANDIDATES) fail('Static HTML project candidate count exceeds limit');
  const proven = [];
  for (const file of html) {
    if (isPE(file.bytes) || isASAR(file.bytes)) fail(`Nested executable/ASAR disguised as HTML is unsupported: ${file.name}`);
    // A recognized but damaged payload is an error, never a recovery fallback.
    try { proven.push({ inner: await unpack(file.bytes), source: file.name }); }
    catch (error) { fail(`Invalid static HTML project payload ${file.name}: ${error.message}`); }
  }
  if (proven.length > 1) fail('Ambiguous container: multiple static HTML project payloads');
  return proven[0] || null;
};

const wrap = (inner, format, facts, note) => ({
  ...inner, format,
  notes: [note, ...(inner.notes || [])],
  metadata: { ...inner.metadata, executableContainer: { ...facts, innerFormat: inner.format, executesInput: false } }
});

/** Dependencies supply the existing staticUnpack limits and ZIP CRC reader. */
export const executableUnpack = async (data, { limits, safePath, unpack, readZipEntries }) => {
  boundedInput(data, limits);
  if (isPE(data)) {
    const scan = scanPEZipCandidates(data, { limits, safePath });
    // A malformed standalone archive is not a harmless PK decoy. Refuse it
    // rather than recovering a different project; signatures inside a proven
    // container remain subject to that container's CRC/project checks.
    if (scan.rejected.some((item) => item.archiveLike && !scan.candidates.some((candidate) =>
      item.start >= candidate.start && item.end <= candidate.end))) {
      fail(`Invalid appended ZIP candidate: ${scan.rejected.filter((item) => item.archiveLike).map((item) => item.error).join('; ')}`);
    }
    const proven = [];
    for (const candidate of scan.candidates) {
      // JSZip searches for the last EOCD signature, even inside its comment.
      // The comment is not project data; remove it only after validating bounds.
      const archive = Uint8Array.from(data.subarray(candidate.start, candidate.eocd + 22));
      viewOf(archive).setUint16(archive.length - 2, 0, true);
      const entries = await readZipEntries(archive, candidate.entries);
      const payload = await unpackEntries(entries, unpack, limits, archive, safePath);
      if (payload) proven.push({ ...payload, candidate });
    }
    if (proven.length > 1) fail('Ambiguous executable: multiple appended ZIP candidates contain Scratch projects');
    if (!proven.length) fail(`PE has no validated static Scratch payload in bounded appended ZIP candidates (${scan.candidates.length}); rejected EOCD signatures: ${scan.rejected.map((item) => item.error).join('; ') || 'none'}`);
    const { inner, source, candidate } = proven[0];
    const trailingBytes = data.length - candidate.end;
    // Earlier EOCDs inside ZIP data/comments are signatures, not extra archives.
    // A separate malformed trailing archive is not silently discarded.
    if (scan.rejected.some((item) => item.offset >= candidate.end)) fail('Invalid trailing ZIP EOCD after the selected executable archive');
    return wrap(inner, 'nwjs-exe-zip', {
      kind: 'pe-appended-zip', ...candidate, overlayOffset: scan.overlayOffset,
      candidateCount: scan.candidates.length, rejectedSignatures: scan.rejected.length,
      rejectedEOCD: scan.rejected, trailingBytes, source
    }, `PE appended ZIP (NW.js-compatible structure): bytes ${candidate.start}..${candidate.end}, payload ${source}; ${scan.rejected.length} rejected EOCD signatures, ${trailingBytes} trailing bytes; static validation only, runtime identity unverified`);
  }
  if (isASAR(data)) {
    const asar = readASAR(data, { limits, safePath });
    if (asar.missingExternalAssets.length) throw missingError(asar.missingExternalAssets);
    const payload = await unpackEntries(asar.entries, unpack, limits, undefined, safePath);
    if (!payload) fail('ASAR contains no validated static HTML/project.zip/project.json Scratch payload');
    return wrap(payload.inner, 'electron-asar', {
      kind: 'asar', headerBytes: asar.headerBytes, dataOffset: asar.dataOffset,
      entryCount: asar.entryCount, source: payload.source, integrity: 'bounds; declared SHA256 when present'
    }, `Standalone Electron-compatible ASAR: ${asar.entryCount} entries, payload ${payload.source}; pickle/header and packed ranges validated; static validation only, runtime identity unverified`);
  }
  return null;
};

/** Fingerprints/container structure only: does not claim project extraction. */
export const identifyExecutable = (data, options) => {
  if (isPE(data)) {
    try {
      const scan = scanPEZipCandidates(data, options);
      return { family: 'exe', format: scan.candidates.length ? 'nwjs-exe-zip' : 'windows-exe', details: {
        kind: 'pe-appended-zip', overlayOffset: scan.overlayOffset, zipCandidates: scan.candidates,
        rejectedEOCD: scan.rejected, projectValidated: false,
        note: 'PE/ZIP structure only; NW.js/Electron runtime identity and Scratch payload require separate verification'
      } };
    } catch (error) { return { family: 'exe', format: 'windows-exe', details: { error: error.message, projectValidated: false } }; }
  }
  if (isASAR(data)) {
    try {
      const asar = readASAR(data, options);
      return { family: 'asar', format: 'electron-asar', details: {
        headerBytes: asar.headerBytes, dataOffset: asar.dataOffset, entries: asar.entryCount,
        missingExternalAssets: asar.missingExternalAssets, projectValidated: false,
        note: 'Standalone ASAR structure only; Electron runtime identity and Scratch payload unverified'
      } };
    } catch (error) { return { family: 'asar', format: 'electron-asar', details: { error: error.message, projectValidated: false } }; }
  }
  return null;
};
