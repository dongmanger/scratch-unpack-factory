// 格式指纹识别不是解包成功声明；HTML 属性和预编译解析与 staticUnpack 共用。
import { getProjectChunks, getChunksLength, inspectCompiledProjectHTML, isScratch1, parseScripts, STATIC_UNPACK_LIMITS, assertSafePath } from './static-unpack.mjs';
import { identifyExecutable } from './executable-unpack.mjs';
import { decodeWithoutLengthHeader, MAX_PROJECT_BYTES } from './base85.mjs';

/** @returns {Promise<{family: string, format: string, details: object}>} */
export const identify = async (data) => {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length > MAX_PROJECT_BYTES) return { family: 'unknown', format: 'unknown', details: { error: 'Input exceeds container size limit' } };
  const executable = identifyExecutable(u8, { limits: STATIC_UNPACK_LIMITS, safePath: assertSafePath });
  if (executable) return executable;
  if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b &&
      ((u8[2] === 3 && u8[3] === 4) || (u8[2] === 5 && u8[3] === 6) || (u8[2] === 7 && u8[3] === 8))) {
    return { family: 'zip', format: 'zip', details: { note: 'ZIP 指纹；工程结构及解压完整性需 staticUnpack 验证' } };
  }
  if (isScratch1(u8)) return { family: 'scratch', format: 'scratch1-binary', details: { magic: new TextDecoder().decode(u8.subarray(0, 10)) } };

  const text = new TextDecoder().decode(u8);
  const details = {};
  try {
    const scripts = parseScripts(text);
    for (const [kind, family, format] of [['o2', '02engine', 'o2-html-chunk'], ['tw', 'turbowarp', 'tw-html-chunk-v4']]) {
      const chunks = getProjectChunks(scripts, kind);
      if (!chunks.length) continue;
      details.chunks = chunks.length;
      details.totalBytes = getChunksLength(chunks);
      // 指纹层也不能把损坏编码当合法分块；工程 ZIP/magic 校验仍由解包入口执行。
      for (const chunk of chunks) decodeWithoutLengthHeader(chunk.payload, chunk.length);
      if (kind === 'o2') {
        const info = inspectCompiledProjectHTML(text, scripts);
        details.precompile = info.detected;
        details.compiledProjectExtracted = !!info.compiledProject;
        if (info.warnings.length) details.warnings = info.warnings;
        return { family, format: info.detected ? 'o2-html-precompile' : format, details };
      }
      return { family, format, details };
    }
    if (scripts.some((script) => script.attributes.type === 'p4-project')) {
      return { family: 'turbowarp', format: 'tw-html-p4-project', details };
    }
    if (scripts.some((script) => script.attributes.id === 'p4-encoded-project-data') || /const\s+result\s*=\s*base85decode\("/.test(text)) {
      return { family: 'turbowarp', format: 'tw-html-p4-encoded', details };
    }
  } catch (error) {
    return { family: 'unknown', format: 'unknown', details: { error: error.message } };
  }

  if (/const getProjectData = \(\) => fetch\("data:[a-zA-Z0-9+/=\-:;,]+"\)/.test(text) || /^FILE = "data:application\/octet-stream;base64,/m.test(text)) {
    return { family: 'turbowarp', format: 'tw-html-base64', details };
  }
  if (/window\.__PACKAGER__ = {\n    projectData: "/.test(text)) {
    return { family: 'turbowarp', format: 'tw-legacy-html-base64', details };
  }
  if (text.includes('<script src="script.js"></script>')) {
    return { family: 'turbowarp', format: 'tw-zip-env-html', details: { note: 'zip 打包环境 HTML：需同目录完整文件（project.zip/script.js）' } };
  }
  if (/<canvas class="sc-canvas"|<style class="scratch-render-styles"/.test(text)) {
    return { family: 'unknown', format: 'loaded-export-html', details: { note: '疑似运行后另存的 HTML，工程数据已被移除' } };
  }
  if (/var project = '[a-zA-Z0-9+/=\-:;,]+';/.test(text)) {
    return { family: 'forkphorus', format: 'forkphorus-html-base64', details };
  }
  if (/const GENERATED = \d+\s*\nconst initOptions = \{/.test(text)) {
    return { family: 'htmlifier', format: 'htmlifier-initoptions', details };
  }
  if (/var TYPE = 'json',\nPROJECT_JSON = "/.test(text)) {
    return { family: 'htmlifier', format: 'htmlifier-type-json', details };
  }
  return { family: 'unknown', format: 'unknown', details };
};
