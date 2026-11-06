import JavaScriptObfuscator from 'javascript-obfuscator';
import {createRequire} from 'node:module';
import {compiledFixture} from './compiled-fixtures.mjs';

const require = createRequire(import.meta.url);
export const OBFUSCATOR_VERSION = require('javascript-obfuscator/package.json').version;
export const OBFUSCATION_LEVELS = Object.freeze(['light', 'balanced', 'strong']);
export const CORPUS_SEEDS = Object.freeze([12345, 67890]);

// Copied from research/02engine/packager/src/packager/packager.js:48-133.
// These are the official presets, without weakening selfDefending or RC4.
// This corpus runs the real obfuscator, NOT the complete 02 packager/compiler.
const commonOptions = {
  compact: true,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  simplify: true,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayIndexesType: ['hexadecimal-number'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersType: 'function',
  target: 'browser',
  transformObjectKeys: false,
  unicodeEscapeSequence: false
};

const freezeOptions = options => Object.freeze({
  ...options,
  stringArrayEncoding: Object.freeze([...options.stringArrayEncoding]),
  stringArrayIndexesType: Object.freeze([...options.stringArrayIndexesType])
});

export const OFFICIAL_02_PRESETS = Object.freeze({
  light: freezeOptions({
    ...commonOptions,
    controlFlowFlattening: false,
    numbersToExpressions: false,
    selfDefending: false,
    splitStrings: false,
    stringArrayEncoding: [],
    stringArrayWrappersCount: 1,
    stringArrayThreshold: 0.75
  }),
  balanced: freezeOptions({
    ...commonOptions,
    controlFlowFlattening: false,
    numbersToExpressions: true,
    selfDefending: false,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArrayEncoding: ['base64'],
    stringArrayWrappersCount: 1,
    stringArrayThreshold: 1
  }),
  strong: freezeOptions({
    ...commonOptions,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.3,
    numbersToExpressions: true,
    selfDefending: true,
    splitStrings: true,
    splitStringsChunkLength: 6,
    stringArrayEncoding: ['rc4'],
    stringArrayWrappersCount: 2,
    stringArrayThreshold: 1
  })
});

const GENERIC_FIXTURES = [
  {
    id: 'constant-strings',
    targetIndex: 0,
    factorySource: `(function constantFactory(thread) {
      const stage = thread.target.runtime.getTargetForStage();
      return function body() {
        const labels = ['准备开始', 'constant-alpha', 'constant-beta', '结束'];
        stage.variables.varId1.value = labels[0] + ':' + labels[1] + ':' + labels[2] + ':' + labels[3];
        startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: '常量广播'});
        retire();
        return 'constant-result';
      };
    })`,
    expected: {
      stageValue: '准备开始:constant-alpha:constant-beta:结束', localValue: 11,
      broadcasts: [['event_whenbroadcastreceived', '常量广播']], waits: [],
      retired: 1, yielded: [], returned: {type: 'string', value: 'constant-result'}
    }
  },
  {
    id: 'object-proxy-functions',
    targetIndex: 1,
    factorySource: `(function proxyFactory(thread) {
      const stage = thread.target.runtime.getTargetForStage();
      const proxy = {
        add: function (a, b) { return a + b; },
        multiply: function (a, b) { return a * b; },
        invoke: function (fn, a, b) { return fn(a, b); },
        opcode: 'event_whenbroadcastreceived', label: '代理广播'
      };
      return function body() {
        stage.variables.varId1.value = proxy.add(stage.variables.varId1.value, 5);
        thread.target.variables.localScore.value = proxy.multiply(stage.variables.varId1.value, 2);
        proxy.invoke(startHats, proxy.opcode, {BROADCAST_OPTION: proxy.label});
        retire();
        return proxy.add('proxy-', 'result');
      };
    })`,
    expected: {
      stageValue: 12, localValue: 24,
      broadcasts: [['event_whenbroadcastreceived', '代理广播']], waits: [],
      retired: 1, yielded: [], returned: {type: 'string', value: 'proxy-result'}
    }
  },
  {
    id: 'flattened-control-flow',
    targetIndex: 1,
    factorySource: `(function flattenedFactory(thread) {
      const stage = thread.target.runtime.getTargetForStage();
      return function body() {
        const order = '2|0|3|1|4'.split('|');
        let cursor = 0;
        while (true) {
          switch (order[cursor++]) {
            case '0': thread.target.variables.localScore.value = stage.variables.varId1.value * 3; continue;
            case '1': retire(); continue;
            case '2': stage.variables.varId1.value = stage.variables.varId1.value + 2; continue;
            case '3': startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: '平坦化广播'}); continue;
            case '4': return 'flow-result';
          }
          break;
        }
      };
    })`,
    expected: {
      stageValue: 9, localValue: 27,
      broadcasts: [['event_whenbroadcastreceived', '平坦化广播']], waits: [],
      retired: 1, yielded: [], returned: {type: 'string', value: 'flow-result'}
    }
  }
];

let fixturesPromise;
export function getTrustedFixtures() {
  fixturesPromise ??= compiledFixture().then(({bundle}) => {
    const factories = [
      {
        id: 'compiled-stage-factory', targetIndex: 0,
        factorySource: bundle.compiledTargets[0].scripts.a.factorySource,
        expected: {
          stageValue: '准备', localValue: 11,
          broadcasts: [['event_whenbroadcastreceived', 'StartGame']], waits: [],
          retired: 1, yielded: [], returned: {type: 'undefined'}
        }
      },
      {
        id: 'compiled-generator-factory', targetIndex: 1,
        factorySource: bundle.compiledTargets[1].scripts.r.factorySource,
        expected: {
          stageValue: 7, localValue: 7,
          broadcasts: [['event_whenbroadcastreceived', '开始游戏']], waits: [['hat-1']],
          retired: 1, yielded: ['wait:hat-1'], returned: {type: 'undefined'}
        }
      }
    ];
    return Object.freeze([...factories, ...GENERIC_FIXTURES].map(fixture => Object.freeze(fixture)));
  });
  return fixturesPromise;
}

export function wrapTrustedFactory(factorySource) {
  return `(()=>{const __corpusFactory=${factorySource};return __corpusFactory;})()`;
}

export function obfuscateTrustedFixture(fixture, {level, seed}) {
  if (OBFUSCATOR_VERSION !== '4.1.1') {
    throw new Error(`Corpus requires local javascript-obfuscator@4.1.1; found ${OBFUSCATOR_VERSION}`);
  }
  if (!Object.hasOwn(OFFICIAL_02_PRESETS, level)) throw new Error(`Unknown preset: ${level}`);
  if (!Number.isSafeInteger(seed) || seed <= 0) throw new Error('Seed must be a positive integer');
  const preset = OFFICIAL_02_PRESETS[level];
  const options = {
    ...preset,
    stringArrayEncoding: [...preset.stringArrayEncoding],
    stringArrayIndexesType: [...preset.stringArrayIndexesType],
    seed
  };
  const obfuscatedSource = JavaScriptObfuscator.obfuscate(
    wrapTrustedFactory(fixture.factorySource), options
  ).getObfuscatedCode();
  return {
    id: `${fixture.id}/${level}/seed-${seed}`,
    fixture, level, seed, options, obfuscatedSource,
    evalSource: `eval(${JSON.stringify(obfuscatedSource)})`,
    provenance: 'javascript-obfuscator@4.1.1 with official 02 presets; not a complete 02 packager run'
  };
}

// Async iteration keeps generation lazy and avoids storing the entire corpus.
// Each entry supplies both plain obfuscator output and its literal eval shell.
export async function* createObfuscationCorpus({
  levels = OBFUSCATION_LEVELS,
  seeds = CORPUS_SEEDS
} = {}) {
  const fixtures = await getTrustedFixtures();
  for (const level of levels) {
    for (const seed of seeds) {
      for (const fixture of fixtures) {
        yield obfuscateTrustedFixture(fixture, {level, seed});
      }
    }
  }
}
