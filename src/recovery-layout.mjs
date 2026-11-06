/**
 * Synthetic editor layout for an already emitted, validated recovered SB3 graph.
 * These bounds are conservative estimates, not renderer measurements. This does
 * not validate opcode semantics, reference definitions, or graph completeness;
 * the caller must establish those before calling it. Only editor coordinates
 * are changed. All traversal and coordinate writes are staged before mutation.
 */
export const RECOVERY_LAYOUT_LIMITS = Object.freeze({maxNodes: 50_000, maxDepth: 128, maxCoordinate: 100_000_000});
const isDict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const fail = message => { throw new TypeError(`recovery layout: ${message}`); };
const LEFT = 60, TOP = 60, COLUMNS = 3, COLUMN_GAP = 80, ROW_GAP = 100;
const COMMENT_GAP = 40, COMMENT_ROW_GAP = 24;
const rect = (x, y, width, height) => ({x, y, width, height});

export function layoutRecoveredProject(project) {
  if (!isDict(project) || !Array.isArray(project.targets)) fail('project.targets must be an array');
  let nodes = 0;
  const tick = (depth = 0) => {
    if (++nodes > RECOVERY_LAYOUT_LIMITS.maxNodes) throw new RangeError('recovery layout: node limit exceeded');
    if (depth > RECOVERY_LAYOUT_LIMITS.maxDepth) throw new RangeError('recovery layout: depth limit exceeded');
  };
  const coordinate = value => {
    if (!Number.isFinite(value) || value < 0 || value > RECOVERY_LAYOUT_LIMITS.maxCoordinate) {
      throw new RangeError('recovery layout: estimated coordinate limit exceeded');
    }
    return value;
  };
  const textWidth = value => {
    if (typeof value !== 'string' && typeof value !== 'number') fail('display values must be strings or numbers');
    return coordinate(32 + String(value).length * 10);
  };
  const staged = [];
  const targetReports = [];
  const stageXY = (object, x, y, primitive = false) => {
    coordinate(x); coordinate(y);
    for (const key of primitive ? ['3', '4'] : ['x', 'y']) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor ? !own(descriptor, 'value') || !descriptor.writable : !Object.isExtensible(object)) {
        fail('editor coordinates must be writable data properties');
      }
    }
    staged.push({object, x, y, primitive});
  };

  for (const [targetIndex, target] of project.targets.entries()) {
    tick();
    if (!isDict(target) || !isDict(target.blocks) || (target.comments !== undefined && !isDict(target.comments))) {
      fail(`target ${targetIndex} needs block/comment dictionaries`);
    }
    const blocks = target.blocks;
    const comments = target.comments || {};
    const owners = new Map();
    const active = new Set();
    const roots = Object.keys(blocks).sort().filter(id => {
      const block = blocks[id];
      if (Array.isArray(block)) return [12, 13].includes(block[0]) && block.length === 5;
      return block?.topLevel === true && block.shadow !== true;
    });
    const items = [];
    const inline = (value, depth) => {
      tick(depth);
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) fail('invalid inline input primitive');
      if ([11, 12, 13].includes(value[0])) return {width: textWidth(value[1]), height: 40};
      if (!Number.isInteger(value[0]) || value[0] < 4 || value[0] > 10) fail('unknown inline input primitive');
      return {width: textWidth(value[1]), height: 40};
    };
    const chain = (firstId, rootId, depth) => {
      if (depth > RECOVERY_LAYOUT_LIMITS.maxDepth) throw new RangeError('recovery layout: depth limit exceeded');
      let id = firstId;
      let width = 0, height = 0;
      const entered = [];
      try {
        while (id !== null && id !== undefined) {
          tick(depth);
          if (typeof id !== 'string' || !own(blocks, id) || !isDict(blocks[id])) fail(`missing block ${JSON.stringify(id)}`);
          if (active.has(id)) fail(`cycle at block ${JSON.stringify(id)}`);
          if (owners.has(id)) fail(`block ${JSON.stringify(id)} has multiple graph owners`);
          const block = blocks[id];
          if (id !== rootId && block.topLevel === true) fail(`nested top-level block ${JSON.stringify(id)}`);
          active.add(id); entered.push(id); owners.set(id, rootId);
          if (typeof block.opcode !== 'string' || !isDict(block.inputs) || !isDict(block.fields)) fail(`invalid block ${JSON.stringify(id)}`);
          let headerWidth = Math.max(180, textWidth(block.opcode.replaceAll('_', ' ')));
          let headerHeight = 52;
          for (const field of Object.values(block.fields)) {
            tick(depth);
            if (!Array.isArray(field) || !field.length) fail('invalid field');
            headerWidth += textWidth(field[0]);
          }
          if (block.mutation?.proccode !== undefined) headerWidth += textWidth(block.mutation.proccode);
          const stacks = [];
          for (const [name, input] of Object.entries(block.inputs)) {
            tick(depth);
            if (!Array.isArray(input) || ![1, 2, 3].includes(input[0]) || input.length !== (input[0] === 3 ? 3 : 2)) {
              fail('invalid input descriptor');
            }
            let inputWidth = 0, inputHeight = 0;
            // Traverse inactive shadows too: they still have graph ownership,
            // and a saved menu can be wider than the active reporter.
            for (const descriptor of input.slice(1)) {
              if (descriptor === null) continue;
              const size = typeof descriptor === 'string' ? chain(descriptor, rootId, depth + 1) : inline(descriptor, depth + 1);
              inputWidth = Math.max(inputWidth, size.width);
              inputHeight = Math.max(inputHeight, size.height);
            }
            if (name === 'SUBSTACK' || name === 'SUBSTACK2') stacks.push({width: inputWidth, height: inputHeight});
            else {
              headerWidth += inputWidth + 24;
              headerHeight = Math.max(headerHeight, inputHeight + 24);
            }
          }
          let blockWidth = headerWidth, blockHeight = headerHeight;
          for (const stack of stacks) {
            blockWidth = Math.max(blockWidth, stack.width + 64);
            blockHeight += stack.height + 32;
          }
          width = coordinate(Math.max(width, blockWidth));
          height = coordinate(height + blockHeight);
          id = block.next;
        }
      } finally { for (const id of entered) active.delete(id); }
      return {width, height};
    };

    for (const blockId of roots) {
      const block = blocks[blockId];
      let size;
      if (Array.isArray(block)) {
        tick();
        owners.set(blockId, blockId);
        size = {width: textWidth(block[1]), height: 40};
      } else size = chain(blockId, blockId, 0);
      items.push({blockId, primitive: Array.isArray(block), code: size, width: size.width, height: size.height, comments: []});
    }
    if (owners.size !== Object.keys(blocks).length) fail(`target ${targetIndex} contains an unowned block`);
    const rootItems = new Map(items.map(item => [item.blockId, item]));
    for (const commentId of Object.keys(comments).sort()) {
      tick();
      const comment = comments[commentId];
      if (!isDict(comment)) fail('invalid comment');
      const width = comment.width ?? 360, height = comment.height ?? 130;
      if (typeof width !== 'number' || width <= 0 || typeof height !== 'number' || height <= 0) fail('comment dimensions must be positive numbers');
      coordinate(width); coordinate(height);
      const commentData = {commentId, width, height};
      if (comment.blockId === null || comment.blockId === undefined) {
        items.push({blockId: null, code: {width: 0, height: 0}, width, height, comments: [commentData], detached: true});
      } else {
        const owner = rootItems.get(owners.get(comment.blockId));
        if (!owner) fail(`comment ${JSON.stringify(commentId)} has no graph owner`);
        owner.comments.push(commentData);
      }
    }
    for (const item of items) {
      if (item.detached || !item.comments.length) continue;
      const commentWidth = Math.max(...item.comments.map(comment => comment.width));
      const commentHeight = item.comments.reduce((sum, comment, i) => sum + comment.height + (i ? COMMENT_ROW_GAP : 0), 0);
      item.width = coordinate(item.code.width + COMMENT_GAP + commentWidth);
      item.height = coordinate(Math.max(item.code.height, commentHeight));
    }

    // Column widths and row heights reflect complete graph/comment extents,
    // rather than a fixed 480x720 cell which cannot contain long C-shaped stacks.
    const columnWidths = [0, 0, 0];
    const rowHeights = [];
    items.forEach((item, ordinal) => {
      const column = ordinal % COLUMNS, row = Math.floor(ordinal / COLUMNS);
      columnWidths[column] = Math.max(columnWidths[column], item.width);
      rowHeights[row] = Math.max(rowHeights[row] || 0, item.height);
    });
    const columnXs = [LEFT];
    for (let i = 1; i < COLUMNS; i++) columnXs[i] = coordinate(columnXs[i - 1] + columnWidths[i - 1] + COLUMN_GAP);
    const rowYs = [TOP];
    for (let i = 1; i < rowHeights.length; i++) rowYs[i] = coordinate(rowYs[i - 1] + rowHeights[i - 1] + ROW_GAP);
    const placed = items.map((item, ordinal) => {
      const x = columnXs[ordinal % COLUMNS], y = rowYs[Math.floor(ordinal / COLUMNS)];
      coordinate(x + item.width); coordinate(y + item.height);
      if (item.blockId !== null) stageXY(blocks[item.blockId], x, y, item.primitive);
      let commentY = y;
      const commentBounds = item.comments.map(comment => {
        const commentX = item.detached ? x : x + item.code.width + COMMENT_GAP;
        stageXY(comments[comment.commentId], commentX, commentY);
        const result = {commentId: comment.commentId, bounds: rect(commentX, commentY, comment.width, comment.height)};
        commentY += comment.height + COMMENT_ROW_GAP;
        return result;
      });
      return {blockId: item.blockId, ordinal, estimated: true,
        bounds: rect(x, y, item.width, item.height), codeBounds: rect(x, y, item.code.width, item.code.height), comments: commentBounds};
    });
    targetReports.push({targetIndex, columns: COLUMNS, estimated: true, blocks: owners.size,
      roots: roots.length, comments: Object.keys(comments).length, items: placed,
      bounds: rect(LEFT, TOP, placed.reduce((max, item) => Math.max(max, item.bounds.x + item.bounds.width - LEFT), 0),
        placed.reduce((max, item) => Math.max(max, item.bounds.y + item.bounds.height - TOP), 0))});
  }

  for (const {object, x, y, primitive} of staged) {
    for (const [key, value] of primitive ? [['3', x], ['4', y]] : [['x', x], ['y', y]]) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      Object.defineProperty(object, key, descriptor ? {...descriptor, value} : {value, writable: true, enumerable: true, configurable: true});
    }
  }
  return {applied: true, basis: 'estimated-sb3-graph-geometry', estimated: true, measured: false,
    reason: 'synthetic-editor-layout-original-coordinates-unavailable', targets: targetReports,
    rootsPlaced: targetReports.reduce((sum, target) => sum + target.roots, 0),
    commentsPlaced: targetReports.reduce((sum, target) => sum + target.comments, 0), traversalNodes: nodes};
}
