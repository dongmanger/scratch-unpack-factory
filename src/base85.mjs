// TurboWarp / 02Engine 自定义 base85（小端序）。
// v2-v4: 0x2a-0x7e，<(0x3c)→"("、>(0x3e)→")"。
// v1: 0x29-0x7d，反斜杠 (0x5c)→"~"。

export const MAX_PROJECT_BYTES = 256 * 1024 * 1024;

export const validateLength = (length) => {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROJECT_BYTES) {
    throw new Error(`Invalid or excessive base85 length (limit ${MAX_PROJECT_BYTES} bytes)`);
  }
  return length;
};

const encodeCharV2 = (n) => {
  n += 0x2a;
  if (n === 0x3c) return 0x28;
  if (n === 0x3e) return 0x29;
  return n;
};
const encodeCharV1 = (n) => {
  n += 0x29;
  return n === 0x5c ? 0x7e : n;
};

function encodeBase(uint8, charFn) {
  const originalLength = validateLength(uint8.length);
  let dataView;
  if (originalLength % 4 !== 0) {
    const padded = new Uint8Array(Math.ceil(originalLength / 4) * 4);
    padded.set(uint8);
    dataView = new DataView(padded.buffer);
  } else {
    dataView = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
  }
  const result = new Uint8Array(Math.ceil(originalLength / 4) * 5);
  let ri = 0;
  for (let i = 0; i < dataView.byteLength; i += 4) {
    let n = dataView.getUint32(i, true);
    for (let k = 0; k < 5; k++) {
      result[ri++] = charFn(n % 85);
      n = Math.floor(n / 85);
    }
  }
  return new TextDecoder().decode(result);
}

export const encode = (uint8) => encodeBase(uint8, encodeCharV2);
export const encodeV1 = (uint8) => encodeBase(uint8, encodeCharV1);
export const encodeV2WithLength = (uint8) => `${uint8.length},${encode(uint8)}`;
export const encodeV3WithLength = (uint8) => {
  const header = String(uint8.length).split('').map((d) => String.fromCharCode(d.charCodeAt(0) + 49)).join('');
  return `${header},${encode(uint8)}`;
};

const decodeValue = (code) => {
  if (code === 0x28) return 0x3c - 0x2a;
  if (code === 0x29) return 0x3e - 0x2a;
  if (code < 0x2a || code > 0x7e || code === 0x3c || code === 0x3e) return -1;
  return code - 0x2a;
};
const decodeValueV1 = (code) => {
  if (code === 0x7e) return 0x5c - 0x29;
  if (code < 0x29 || code > 0x7d || code === 0x5c) return -1;
  return code - 0x29;
};

function decodeBase(str, length, getValue) {
  validateLength(length);
  if (typeof str !== 'string' || str.length % 5 !== 0 || str.length !== Math.ceil(length / 4) * 5) {
    throw new Error('Invalid base85 group count / declared length');
  }
  const result = new Uint8Array(length);
  for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
    let n = 0;
    let multiplier = 1;
    for (let k = 0; k < 5; k++) {
      const value = getValue(str.charCodeAt(i + k));
      if (value < 0 || value >= 85) throw new Error(`Invalid base85 character at ${i + k}`);
      n += value * multiplier;
      multiplier *= 85;
    }
    if (n > 0xffffffff) throw new Error('Invalid base85 group: uint32 overflow');
    for (let k = 0; k < 4; k++) {
      const byte = n % 256;
      n = Math.floor(n / 256);
      if (j + k < length) result[j + k] = byte;
      else if (byte !== 0) throw new Error('Invalid base85 padding for declared length');
    }
  }
  return result;
}

/** v4：无长度头，必须与逐块 data-size/decodeChunk 的字节数一致。 */
export function decodeWithoutLengthHeader(str, length) {
  return decodeBase(str, length, decodeValue);
}

/** 数字头不能唯一判别 v1/v2；容器层须验证候选是否为真实工程。 */
export function decodeWithLengthHeaderCandidates(str) {
  if (typeof str !== 'string') throw new Error('Invalid base85 input');
  const separator = str.indexOf(',');
  if (separator < 1) throw new Error('Invalid base85 length header');
  const header = str.slice(0, separator);
  const payload = str.slice(separator + 1);
  if (/^[a-j]+$/.test(header)) {
    const length = Number([...header].map((c) => String.fromCharCode(c.charCodeAt(0) - 49)).join(''));
    return [{ version: 3, data: decodeWithoutLengthHeader(payload, length) }];
  }
  if (!/^\d+$/.test(header)) throw new Error('Invalid base85 length header');
  const length = validateLength(Number(header));
  const candidates = [];
  const errors = [];
  for (const [version, decoder] of [[1, decodeValueV1], [2, decodeValue]]) {
    try {
      candidates.push({ version, data: decodeBase(payload, length, decoder) });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!candidates.length) throw new Error(`Invalid base85 payload: ${errors.join('; ')}`);
  return candidates;
}

/** 旧返回类型不变。歧义时拒绝猜测；已知世代可显式传入 version=1/2/3。 */
export function decodeWithLengthHeader(str, version) {
  const candidates = decodeWithLengthHeaderCandidates(str);
  if (version !== undefined) {
    const candidate = candidates.find((c) => c.version === version);
    if (!candidate) throw new Error('Invalid base85 for requested version');
    return candidate.data;
  }
  if (candidates.length > 1 && candidates[0].data.some((b, i) => b !== candidates[1].data[i])) {
    throw new Error('Ambiguous base85 v1/v2; specify a version or validate decoded project candidates');
  }
  return candidates[0].data;
}
