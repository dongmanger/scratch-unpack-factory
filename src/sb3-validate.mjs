// SB3 结构与引用校验。只报告问题，不按名称修复、合并或执行工程代码。

import { createHash } from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {validateProcedures} from './procedure-validate.mjs';

const isDictionary = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const keyPath = (path, key) => `${path}[${JSON.stringify(key)}]`;
const referenceKinds = { VARIABLE: 'variables', LIST: 'lists', BROADCAST_OPTION: 'broadcasts' };
const hashPattern = /^[a-f\d]{32}$/i;

const finish = (errors, warnings, summary = {}) => ({
  ok: errors.length === 0,
  summary,
  issues: [...errors, ...warnings],
  errors,
  warnings
});

// JSZip 会清理 ../ 和 ./ 路径；校验原始文件名，避免把非根目录条目当成 SB3 根文件。
const rootFile = (zip, name) => {
  if (typeof name !== 'string' || !name || /[/\\]/.test(name) || name === '.' || name === '..') return null;
  const file = zip.file(name);
  return file && (!file.unsafeOriginalName || file.unsafeOriginalName === name) ? file : null;
};

/**
 * @param {Uint8Array|Buffer} sb3
 * @returns {Promise<{ok: boolean, summary: object, issues: string[], errors: string[], warnings: string[]}>}
 */
export const validateSb3 = async (sb3) => {
  const errors = [];
  const warnings = [];
  let zip;
  try {
    // 对所有 ZIP 条目检查 CRC32；不启用损坏恢复，也不接受任意目录下的 project.json。
    zip = await JSZip.loadAsync(sb3, { checkCRC32: true });
  } catch (error) {
    errors.push(`zip 无法打开或 CRC32 校验失败: ${error.message}`);
    return finish(errors, warnings);
  }

  const projectFile = rootFile(zip, 'project.json');
  if (!projectFile) {
    errors.push('缺少根目录 project.json（子目录或路径清理后的同名文件不算完整 SB3）');
    return finish(errors, warnings);
  }

  let project;
  try {
    project = JSON.parse(await projectFile.async('text'));
  } catch (error) {
    errors.push(`project.json 解析失败: ${error.message}`);
    return finish(errors, warnings);
  }
  if (!isDictionary(project)) {
    errors.push('project.json 根值必须是对象');
    return finish(errors, warnings);
  }
  if (!Array.isArray(project.targets) || project.targets.length === 0) {
    errors.push('targets 必须是非空数组');
    return finish(errors, warnings);
  }

  const dictionary = (value, path, required = false) => {
    if (value === undefined && !required) return {};
    if (isDictionary(value)) return value;
    errors.push(`${path} 必须是字典对象`);
    return {};
  };
  const array = (value, path) => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    errors.push(`${path} 必须是数组`);
    return [];
  };

  // 先收集所有定义，再校验引用；舞台在 targets 中的位置不影响 ID 解析。
  const states = project.targets.map((target, index) => {
    const path = `targets[${index}]`;
    if (!isDictionary(target)) {
      errors.push(`${path} 必须是对象`);
      target = {};
    }
    if (typeof target.isStage !== 'boolean') errors.push(`${path}.isStage 必须是布尔值`);
    const state = {
      target, path, definitions: new Map(),
      blocks: dictionary(target.blocks, `${path}.blocks`, true),
      variables: dictionary(target.variables, `${path}.variables`),
      lists: dictionary(target.lists, `${path}.lists`),
      broadcasts: dictionary(target.broadcasts, `${path}.broadcasts`),
      costumes: array(target.costumes, `${path}.costumes`),
      sounds: array(target.sounds, `${path}.sounds`)
    };
    for (const kind of ['variables', 'lists', 'broadcasts']) {
      for (const [id, definition] of Object.entries(state[kind])) {
        const definitionPath = keyPath(`${path}.${kind}`, id);
        if (!id) errors.push(`${definitionPath} 定义 ID 不能为空`);
        let valid;
        if (kind === 'broadcasts') {
          valid = typeof definition === 'string';
        } else if (kind === 'lists') {
          valid = Array.isArray(definition) && definition.length === 2 &&
            typeof definition[0] === 'string' && Array.isArray(definition[1]);
        } else {
          valid = Array.isArray(definition) && (definition.length === 2 || definition.length === 3) &&
            typeof definition[0] === 'string' && (definition.length === 2 || definition[2] === true);
        }
        if (!valid) {
          const format = kind === 'broadcasts' ? '名称字符串' :
            kind === 'lists' ? '[名称, 内容数组]' : '[名称, 值] 或 [名称, 值, true]';
          errors.push(`${definitionPath} 定义格式应为 ${format}`);
          continue;
        }
        if (kind === 'variables' && definition[2] === true && target.isStage !== true) {
          errors.push(`${definitionPath} 云变量只能定义在舞台`);
        }
        if (state.definitions.has(id)) {
          errors.push(`${definitionPath} 定义 ID 与 ${state.definitions.get(id).kind} 重复`);
          continue;
        }
        state.definitions.set(id, { kind, name: kind === 'broadcasts' ? definition : definition[0] });
      }
    }
    return state;
  });

  const stages = states.filter((state) => state.target.isStage === true);
  if (stages.length !== 1) errors.push(`targets 必须恰有一个舞台，实际 ${stages.length} 个`);
  const stage = stages.length === 1 ? stages[0] : null;

  const checkDefinitionReference = (state, kind, name, id, path) => {
    if (typeof name !== 'string' || typeof id !== 'string' || !id) {
      errors.push(`${path} 引用必须包含 [名称字符串, 非空 ID 字符串]`);
      return;
    }
    // 不跨其他角色查找，不按名称回退；本地 ID 即使类型错误也不应被舞台同 ID 遮盖。
    const definition = state.definitions.get(id) || stage?.definitions.get(id);
    if (!definition) {
      errors.push(`${path} ${kind} 引用未知 ID ${JSON.stringify(id)}（仅查本地和舞台）`);
    } else if (definition.kind !== kind) {
      errors.push(`${path} ID ${JSON.stringify(id)} 类型不一致: 需要 ${kind}，定义为 ${definition.kind}`);
    } else if (definition.name !== name) {
      errors.push(`${path} 名称与 ID 定义不一致: ${JSON.stringify(name)} != ${JSON.stringify(definition.name)}`);
    }
  };

  const checkPrimitive = (state, primitive, path, topLevel = false) => {
    const type = primitive[0];
    if (topLevel && type !== 12 && type !== 13) {
      errors.push(`${path} 顶层 primitive 只允许变量 12 或列表 13`);
      return;
    }
    if (type === 11 || type === 12 || type === 13) {
      const validLength = type === 11 ? primitive.length === 3 :
        primitive.length === 3 || primitive.length === 5;
      if (!validLength || (primitive.length === 5 && (!isNumber(primitive[3]) || !isNumber(primitive[4])))) {
        errors.push(`${path} primitive ${type} 格式错误（应含名称、ID，顶层坐标须成对且为数值）`);
        return;
      }
      checkDefinitionReference(state, type === 11 ? 'broadcasts' : type === 12 ? 'variables' : 'lists',
        primitive[1], primitive[2], path);
      return;
    }
    if ((Number.isInteger(type) && type >= 4 && type <= 8) || type === 10) {
      if (primitive.length !== 2 || !(typeof primitive[1] === 'string' || isNumber(primitive[1]))) {
        errors.push(`${path} literal primitive ${type} 必须是 [类型, 字符串或数值]`);
      }
    } else if (type === 9) {
      if (primitive.length !== 2 || typeof primitive[1] !== 'string' || !/^#[a-f\d]{6}$/i.test(primitive[1])) {
        errors.push(`${path} 颜色 primitive 9 必须是 [9, "#RRGGBB"]`);
      }
    } else {
      errors.push(`${path} 未知 primitive 类型 ${JSON.stringify(type)}`);
    }
  };

  const checkBlockReference = (state, id, ownerId, path) => {
    if (id === null) return;
    if (typeof id !== 'string' || !id) {
      errors.push(`${path} 必须是非空 block ID 字符串或 null`);
    } else if (id === ownerId) {
      errors.push(`${path} self-link 指向自身 ${JSON.stringify(id)}`);
    } else if (!hasOwn(state.blocks, id)) {
      errors.push(`${path} 引用不存在的 block ID ${JSON.stringify(id)}`);
    }
  };

  const targetSummaries = [];
  for (const state of states) {
    let scripts = 0;
    for (const [id, block] of Object.entries(state.blocks)) {
      const path = keyPath(`${state.path}.blocks`, id);
      if (!id) errors.push(`${path} block ID 不能为空`);
      if (Array.isArray(block)) {
        checkPrimitive(state, block, path, true);
        if ((block[0] === 12 || block[0] === 13) && block.length === 5) scripts++;
        continue;
      }
      if (!isDictionary(block)) {
        errors.push(`${path} 必须是 block 对象或合法变量/列表 primitive 数组`);
        continue;
      }
      if (typeof block.opcode !== 'string' || !block.opcode.trim()) {
        errors.push(`${path}.opcode 必须是非空字符串`);
      }
      // 扩展 opcode 不使用白名单：未知非空 opcode 并不等于非法积木。
      for (const flag of ['topLevel', 'shadow']) {
        if (block[flag] !== undefined && typeof block[flag] !== 'boolean') {
          errors.push(`${path}.${flag} 必须是布尔值`);
        }
      }
      if (block.topLevel === true && block.shadow !== true) scripts++;
      for (const link of ['next', 'parent']) {
        if (block[link] !== undefined) checkBlockReference(state, block[link], id, `${path}.${link}`);
      }

      const fields = dictionary(block.fields, `${path}.fields`);
      for (const [field, value] of Object.entries(fields)) {
        const fieldPath = keyPath(`${path}.fields`, field);
        const kind = hasOwn(referenceKinds, field) ? referenceKinds[field] : null;
        if (!Array.isArray(value) || (kind ? value.length !== 2 : value.length < 1 || value.length > 2)) {
          errors.push(`${fieldPath} field 必须是 ${kind ? '[名称, ID]' : '[值] 或 [值, ID]'} 数组`);
        } else if (kind) {
          checkDefinitionReference(state, kind, value[0], value[1], fieldPath);
        } else if (value.length === 2 && value[1] !== null && typeof value[1] !== 'string') {
          errors.push(`${fieldPath} field ID 必须是字符串或 null`);
        }
      }

      const inputs = dictionary(block.inputs, `${path}.inputs`);
      for (const [input, value] of Object.entries(inputs)) {
        const inputPath = keyPath(`${path}.inputs`, input);
        if (!Array.isArray(value) || ![1, 2, 3].includes(value[0]) ||
            value.length !== (value[0] === 3 ? 3 : 2)) {
          errors.push(`${inputPath} input 必须是 [1, shadow]、[2, block] 或 [3, block, shadow]`);
          continue;
        }
        for (let index = 1; index < value.length; index++) {
          const descriptorPath = `${inputPath}[${index}]`;
          if (Array.isArray(value[index])) checkPrimitive(state, value[index], descriptorPath);
          else checkBlockReference(state, value[index], id, descriptorPath);
        }
      }
    }

    // 线性、非递归检测 next 环；不猜测自定义扩展的语义或强制 parent/next 互为逆关系。
    const visited = new Set();
    for (const start of Object.keys(state.blocks)) {
      if (visited.has(start)) continue;
      const chain = [];
      const positions = new Map();
      let current = start;
      while (typeof current === 'string' && hasOwn(state.blocks, current) && !visited.has(current)) {
        if (positions.has(current)) {
          const cycle = chain.slice(positions.get(current));
          if (cycle.length > 1) {
            errors.push(`${state.path}.blocks 存在 next-cycle: ${[...cycle, current].map((key) => JSON.stringify(key)).join(' -> ')}`);
          }
          break;
        }
        positions.set(current, chain.length);
        chain.push(current);
        const block = state.blocks[current];
        current = isDictionary(block) ? block.next : null;
      }
      for (const key of chain) visited.add(key);
    }

    targetSummaries.push({
      name: state.target.name,
      isStage: state.target.isStage === true,
      blocks: Object.keys(state.blocks).length,
      scripts,
      costumes: state.costumes.length,
      sounds: state.sounds.length
    });
  }

  // 资产只接受根目录的精确文件名；同一文件被多个造型引用时只读取、哈希一次。
  const hashes = new Map();
  const safeAssetName = (name) => typeof name === 'string' &&
    /^[^./\\]+\.[^./\\]+$/.test(name);
  const readHash = (file, filename) => {
    if (!hashes.has(filename)) {
      hashes.set(filename, file.async('uint8array').then((bytes) => createHash('md5').update(bytes).digest('hex')));
    }
    return hashes.get(filename);
  };
  for (const state of states) {
    const currentCostume = state.target.currentCostume;
    if (currentCostume !== undefined && (!Number.isInteger(currentCostume) || currentCostume < 0 ||
        currentCostume >= Math.max(1, state.costumes.length))) {
      errors.push(`${state.path}.currentCostume 必须是造型范围内的非负整数（空造型数组仅允许默认值 0）`);
    }
    for (const kind of ['costumes', 'sounds']) {
      for (const [index, asset] of state[kind].entries()) {
        const path = `${state.path}.${kind}[${index}]`;
        if (!isDictionary(asset)) {
          errors.push(`${path} 必须是资产对象`);
          continue;
        }
        const dataFormat = kind === 'costumes' ?
          asset.dataFormat || asset.assetType?.runtimeFormat || 'png' : asset.dataFormat;
        const hasFormat = typeof dataFormat === 'string' && dataFormat.length > 0 &&
          !/[./\\\x00-\x1f]/.test(dataFormat);
        if (!hasFormat) errors.push(`${path}.dataFormat 必须是非空格式字符串`);
        if (kind === 'costumes') {
          for (const center of ['rotationCenterX', 'rotationCenterY']) {
            if (asset[center] !== undefined && !isNumber(asset[center])) {
              errors.push(`${path}.${center} 必须是有限数值`);
            }
          }
          if (asset.bitmapResolution !== undefined && (!isNumber(asset.bitmapResolution) || asset.bitmapResolution <= 0)) {
            errors.push(`${path}.bitmapResolution 必须是正的有限数值`);
          }
        } else if (!safeAssetName(asset.md5ext)) {
          // Unlike costumes, sb3.parseScratchAssets does not synthesize sound.md5ext.
          errors.push(`${path}.md5ext 必须是根目录资产文件名；声音加载器不支持 assetId/dataFormat 回退`);
        }
        const lookup = typeof asset.assetId === 'string' && hasFormat ?
          `${asset.assetId}.${dataFormat}` : null;
        const filename = asset.md5ext ?? (kind === 'costumes' ? lookup : null);
        if (kind === 'costumes') {
          if (!safeAssetName(lookup)) errors.push(`${path}.assetId/dataFormat 必须组成根目录资产文件名`);
          if (asset.md5ext !== undefined && asset.md5ext !== lookup) {
            errors.push(`${path}.md5ext 与造型加载器使用的 assetId/dataFormat 文件名不一致: ${JSON.stringify(lookup)}`);
          }
          if (lookup !== filename && !rootFile(zip, lookup)) {
            errors.push(`${path} 缺少造型加载器查找的根目录资产: ${JSON.stringify(lookup)}`);
          }
        } else if (safeAssetName(filename) && hasFormat &&
            filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() !== asset.dataFormat.toLowerCase()) {
          errors.push(`${path}.md5ext 扩展名与 dataFormat 不一致`);
        }
        const file = rootFile(zip, filename);
        if (!file) {
          errors.push(`${path} 缺少根目录${kind === 'costumes' ? '造型' : '音效'}资产: ${JSON.stringify(filename)}`);
          continue;
        }
        let actualHash;
        try {
          actualHash = await readHash(file, filename);
        } catch (error) {
          errors.push(`${path} 资产读取失败: ${error.message}`);
          continue;
        }
        const filenameHash = /^([a-f\d]{32})\.[^./\\]+$/i.exec(filename)?.[1];
        const expectedHashes = new Set();
        if (filenameHash) expectedHashes.add(filenameHash.toLowerCase());
        if (typeof asset.assetId === 'string' && hashPattern.test(asset.assetId)) {
          expectedHashes.add(asset.assetId.toLowerCase());
        } else if (asset.assetId !== undefined) {
          warnings.push(`${path}.assetId 不是合法 MD5 字符串`);
        }
        if (expectedHashes.size === 0) warnings.push(`${path} 没有可核验的 MD5 声明`);
        for (const expectedHash of expectedHashes) {
          if (actualHash !== expectedHash) {
            warnings.push(`${path} MD5 不匹配: 声明 ${expectedHash}，实际 ${actualHash}`);
          }
        }
      }
    }
  }

  // TurboWarp fontManager.deserialize skips malformed entries and silently
  // falls back to remote storage for absent custom files. Report those losses.
  const fontFamilies = new Set();
  for (const [index, font] of array(project.customFonts, 'customFonts').entries()) {
    const path = `customFonts[${index}]`;
    if (!isDictionary(font)) {
      errors.push(`${path} 必须是字体对象`);
      continue;
    }
    if (typeof font.system !== 'boolean' || typeof font.family !== 'string' ||
        !/^[-\w ]+$/.test(font.family) || typeof font.fallback !== 'string') {
      errors.push(`${path} 必须包含 system 布尔值、有效 family 和 fallback 字符串`);
    }
    if (typeof font.family === 'string') {
      const family = font.family.toLowerCase();
      if (fontFamilies.has(family)) errors.push(`${path}.family 与先前字体大小写不敏感重名，VM 会跳过此字体`);
      fontFamilies.add(family);
    }
    if (font.system !== false) continue;
    if (!safeAssetName(font.md5ext)) {
      errors.push(`${path}.md5ext 必须是根目录字体资产文件名`);
      continue;
    }
    const file = rootFile(zip, font.md5ext);
    if (!file) {
      errors.push(`${path} 缺少根目录字体资产: ${JSON.stringify(font.md5ext)}`);
      continue;
    }
    try {
      const actualHash = await readHash(file, font.md5ext);
      const expectedHash = /^([a-f\d]{32})\./i.exec(font.md5ext)?.[1];
      if (expectedHash && actualHash !== expectedHash.toLowerCase()) {
        warnings.push(`${path} MD5 不匹配: 声明 ${expectedHash.toLowerCase()}，实际 ${actualHash}`);
      }
    } catch (error) {
      errors.push(`${path} 字体资产读取失败: ${error.message}`);
    }
  }

  const extensions = array(project.extensions, 'extensions');
  const monitors = array(project.monitors, 'monitors');
  const countDefinitions = (kind) => states.reduce((total, state) => total + Object.keys(state[kind]).length, 0);
  const summary = {
    projectType: 'objName' in project ? 'sb2-style' : 'sb3',
    targets: targetSummaries,
    extensions,
    variables: countDefinitions('variables'),
    monitors: monitors.length,
    broadcasts: countDefinitions('broadcasts'),
    lists: countDefinitions('lists'),
    blocks: targetSummaries.reduce((total, target) => total + target.blocks, 0),
    scripts: targetSummaries.reduce((total, target) => total + target.scripts, 0)
  };
  if (summary.blocks === 0) warnings.push('所有 target 的积木数为 0；空项目仍是合法 SB3，不代表已恢复编译代码');
  const procedures = validateProcedures(project);
  errors.push(...procedures.errors);
  warnings.push(...procedures.warnings);
  return finish(errors, warnings, summary);
};
