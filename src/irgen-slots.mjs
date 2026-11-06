/**
 * Which input slots of the vendored 02 compiler put a number cast around their value by themselves.
 *
 * A numeric cast in compiled code, `(+x || 0)` or `toNotNaN(x)`, has two possible origins. Either the slot the
 * value fills converts it to a number (then the author just plugged `x` in and the cast is the compiler's), or
 * the author placed an arithmetic block there (`x + 0`, `x × 1`) and the cast is that block's. Recovery decodes
 * both as `x + 0` / `x × 1`. Dropping the block (src/coercion-unwrap.mjs) is only right for the first origin:
 * a slot that passes its value on unconverted, such as the value of `set v to`, the arguments of a custom block
 * call or the index of `replace item of list`, compiles a bare `x` as `x`, so a cast there can only be the
 * author's own block. Removing it would change what the compiler writes.
 *
 * The table below is read off research/02engine src/compiler/irgen.js as bundled in vendor/02-vm.cjs: every
 * `descendInputOfBlock(block, 'NAME')` immediately followed by `.toType(InputType.NUMBER)`. test/coercion-unwrap.test.mjs
 * derives it again from the vendored bundle with `deriveCastSlots` and fails if the two disagree, so a compiler
 * update cannot leave this list silently out of date.
 */

/** Slots irgen converts to a number: arithmetic operands and the numeric arguments of native commands. */
export const NUMBER_CAST_SLOTS = Object.freeze(new Set([
  'operator_add.NUM1', 'operator_add.NUM2', 'operator_divide.NUM1', 'operator_divide.NUM2', 'operator_mathop.NUM',
  'operator_mod.NUM1', 'operator_mod.NUM2', 'operator_multiply.NUM1', 'operator_multiply.NUM2', 'operator_round.NUM',
  'operator_subtract.NUM1', 'operator_subtract.NUM2', 'control_for_each.VALUE', 'control_repeat.TIMES',
  'control_wait.DURATION', 'data_changevariableby.VALUE', 'looks_changeeffectby.CHANGE', 'looks_changesizeby.CHANGE',
  'looks_goforwardbackwardlayers.NUM', 'looks_seteffectto.VALUE', 'looks_setsizeto.SIZE', 'motion_changexby.DX',
  'motion_changeyby.DY', 'motion_gotoxy.X', 'motion_gotoxy.Y', 'motion_movesteps.STEPS', 'motion_pointindirection.DIRECTION',
  'motion_setx.X', 'motion_sety.Y', 'motion_turnleft.DEGREES', 'motion_turnright.DEGREES',
  'pen_changePenColorParamBy.VALUE', 'pen_changePenHueBy.HUE', 'pen_changePenShadeBy.SHADE', 'pen_setPenColorParamTo.VALUE',
  'pen_setPenHueToNumber.HUE', 'pen_setPenShadeToNumber.SHADE', 'pen_setPenSizeTo.SIZE', 'pen_changePenSizeBy.SIZE'
]));

/** The letter index of `letter N of S` is converted with the dedicated index cast. */
export const INDEX_CAST_SLOTS = Object.freeze(new Set(['operator_letter_of.LETTER']));

/**
 * Slots irgen hands on unconverted but whose code generator still chooses a numeric form from the operand's type:
 * a comparison against a number, a random range, the native array index of `item N of list`. The cast written there
 * is the compiler's own, so removing the block is right. Whether it reproduces the shipped text depends on the
 * type inference of the whole script, which is what the recompilation oracle checks.
 */
export const TYPE_DRIVEN_SLOTS = Object.freeze(new Set([
  'data_itemoflist.INDEX', 'operator_equals.OPERAND1', 'operator_equals.OPERAND2', 'operator_gt.OPERAND1', 'operator_gt.OPERAND2',
  'operator_lt.OPERAND1', 'operator_lt.OPERAND2', 'operator_random.FROM', 'operator_random.TO'
]));

/** Every slot in which a `+ 0` / `× 1` block may be taken for the compiler's own cast and removed. */
export const UNWRAP_SLOTS = Object.freeze(new Set([...NUMBER_CAST_SLOTS, ...INDEX_CAST_SLOTS, ...TYPE_DRIVEN_SLOTS]));

/**
 * Read the number-cast slots out of a bundled compiler. This is the derivation the table above records; it exists
 * so the test can repeat it against vendor/02-vm.cjs.
 * @param {string} bundleSource text of the vendored 02 VM bundle
 * @returns {{number: Set<string>, index: Set<string>}} slots written as `opcode.INPUT`
 */
export function deriveCastSlots(bundleSource) {
  const lines = bundleSource.split('\n');
  const start = lines.findIndex(line => /^  descendInputOfBlock\(parentBlock, inputName, preserveStrings = false\)/.test(line));
  const end = lines.findIndex((line, i) => i > start && /const node = this\.descendStackedBlock\(block\);/.test(line));
  if (start < 0 || end < 0) throw new Error('irgen region not found in the bundle');
  const region = lines.slice(start, end).join('\n');
  // Split into `case 'opcode':` segments; each input read inside a segment belongs to that opcode.
  const marks = [...region.matchAll(/case '([A-Za-z0-9_]+)':/g)].map(match => ({opcode: match[1], from: match.index + match[0].length, at: match.index}));
  const number = new Set(), index = new Set();
  marks.forEach((mark, i) => {
    const body = region.slice(mark.from, i + 1 < marks.length ? marks[i + 1].at : region.length);
    for (const read of body.matchAll(/descendInputOfBlock\(block,\s*'([A-Za-z0-9_]+)'(?:,\s*(?:true|false))?\)\s*\.toType\(InputType\.([A-Z_]+)\)/g)) {
      if (read[2] === 'NUMBER') number.add(`${mark.opcode}.${read[1]}`);
      else if (read[2] === 'NUMBER_INDEX') index.add(`${mark.opcode}.${read[1]}`);
    }
  });
  return {number, index};
}
