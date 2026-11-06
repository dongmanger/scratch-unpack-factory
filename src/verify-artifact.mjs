import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';

export const VERIFY_LIMITS = Object.freeze({
  inputBytes: 256 * 1024 * 1024,
  totalInputBytes: 384 * 1024 * 1024,
  timeoutMs: 600 * 1000,
  maxSteps: 1_000_000,
  terminationMs: 2_000,
  resourceLimits: Object.freeze({maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64,
    codeRangeSizeMb: 64, stackSizeMb: 4})
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inputBytes = (data, name) => {
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  if (!bytes) throw new TypeError(`${name} must be Uint8Array or ArrayBuffer bytes, not a local path`);
  if (bytes.byteLength > VERIFY_LIMITS.inputBytes) throw new RangeError(`${name} exceeds the 256 MiB input limit`);
  return bytes;
};

/**
 * Execute ONLY trusted user artifacts with explicit consent. Compiled factories and
 * even SB3 #code comments can execute arbitrary JavaScript. Worker isolation and
 * best-effort network guards are NOT a security sandbox or filesystem protection.
 * The result describes one bounded, headless green-flag scenario, never source identity.
 */
export async function verifyArtifact({originalData, recoveredData, allowExecute = false,
  timeoutMs = 10000, maxSteps = 1000, originalCompiledProject = null, focusScript = null} = {}) {
  const report = {
    schemaVersion: 1, status: 'refused', matched: false, originalSourceVerified: false,
    execution: {allowed: allowExecute === true, started: false, isolation: 'worker_threads',
      securitySandbox: false, timeoutMs, maxSteps, inputLimitBytes: VERIFY_LIMITS.inputBytes,
      totalInputLimitBytes: VERIFY_LIMITS.totalInputBytes, resourceLimits: {...VERIFY_LIMITS.resourceLimits},
      terminationRequested: false, terminated: false, terminationExitCode: null,
      terminationVerified: false},
    scenario: {trigger: focusScript ? `startHats:${focusScript.opcode}` : 'greenFlag',
      focusedScript: focusScript ? {targetIndex: focusScript.targetIndex, scriptId: focusScript.scriptId, opcode: focusScript.opcode} : null,
      scheduling: 'bounded runtime._step followed by setImmediate',
      maxStepsPerRun: maxSteps, manualTriggers: !!focusScript, headless: true},
    hashes: {algorithm: 'sha256', originalInput: null, recoveredInput: null},
    engine: {module: 'vendor/02-vm.cjs', node: process.version, v8: process.versions.v8,
      version: null, revision: null, sha256: null},
    adapters: {storage: false, renderer: false, audio: false, video: false, cloud: false,
      userInput: false, network: false},
    structural: {original: null, recovered: null, compiledTargets: null},
    recompile: {original: {status: 'not-run'}, recovered: {status: 'not-run'}},
    runs: {original: null, recovered: null},
    behavior: {status: 'not-run', matched: false, scenarioOnly: true, snapshotsEqual: null,
      broadcastsEqual: null, traceEqual: null, traceComparison: null, differences: [], blockers: []},
    limitations: [
      'Only the bounded green-flag scenario and recorded final state/broadcasts are compared; other inputs, events and schedules are untested.',
      'A scenario match does not establish original source identity or universal behavioral equivalence.',
      'Renderer, audio, video, cloud and user input adapters are absent; adapter-dependent operations and unknown extensions cannot establish a match.',
      'The real VM may prune broadcast variables when loading stripped blocks; snapshots retain declared broadcast IDs and label whether each exists in runtime.',
      'Compiled factorySource and SB3 #code comments may execute arbitrary JavaScript. Worker termination, V8 heap limits and network guards are best effort, not a security sandbox; filesystem access and native/external memory are not contained.'
    ],
    error: null
  };
  if (allowExecute !== true) {
    report.error = {code: 'EXECUTION_NOT_ALLOWED', message: 'Verification requires allowExecute === true for trusted artifacts because compiledFactory/factorySource may execute hostile arbitrary JavaScript'};
    return report;
  }

  let original, recovered;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > VERIFY_LIMITS.timeoutMs) {
      throw new RangeError(`timeoutMs must be a positive integer no greater than ${VERIFY_LIMITS.timeoutMs}`);
    }
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > VERIFY_LIMITS.maxSteps) {
      throw new RangeError(`maxSteps must be a positive integer no greater than ${VERIFY_LIMITS.maxSteps}`);
    }
    original = inputBytes(originalData, 'originalData');
    recovered = inputBytes(recoveredData, 'recoveredData');
    if (focusScript && (!Number.isSafeInteger(focusScript.targetIndex) || focusScript.targetIndex < 0 ||
        typeof focusScript.scriptId !== 'string' || typeof focusScript.opcode !== 'string')) {
      throw new TypeError('focusScript must contain targetIndex, scriptId, and opcode');
    }
    if (originalCompiledProject !== null) {
      const bundleBytes = Buffer.byteLength(JSON.stringify(originalCompiledProject));
      if (bundleBytes > VERIFY_LIMITS.inputBytes) throw new RangeError('originalCompiledProject exceeds the 256 MiB limit');
      if (!originalCompiledProject || originalCompiledProject.format !== '02engine-compiled-project' ||
          !originalCompiledProject.compiledTargets || !Array.isArray(originalCompiledProject.targets)) {
        throw new TypeError('originalCompiledProject must be a complete 02Engine compiled project');
      }
      if (!focusScript) throw new TypeError('originalCompiledProject override requires focusScript');
    }
    if (original.byteLength + recovered.byteLength > VERIFY_LIMITS.totalInputBytes) {
      throw new RangeError(`originalData + recoveredData exceeds the ${VERIFY_LIMITS.totalInputBytes} byte total input limit`);
    }
    report.hashes.originalInput = sha256(original);
    report.hashes.recoveredInput = sha256(recovered);
  } catch (error) {
    report.status = 'invalid';
    report.error = {code: 'INVALID_INPUT', message: error.message};
    return report;
  }

  const startedAt = Date.now();
  return new Promise(resolve => {
    let worker, settled = false;
    const finish = async (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (status) {
        report.status = status;
        report.matched = false;
        report.behavior.status = status;
        report.behavior.matched = false;
        report.error = error;
      }
      // Also terminate after a normal result: artifact-created timers must not keep
      // a worker alive after verification, and timeout must cover synchronous hangs.
      if (worker) {
        report.execution.terminationRequested = true;
        let timer;
        try {
          const termination = worker.terminate();
          const exitCode = await Promise.race([
            termination,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Worker termination exceeded ${VERIFY_LIMITS.terminationMs} ms`)),
                VERIFY_LIMITS.terminationMs);
            })
          ]);
          report.execution.terminationExitCode = exitCode;
          report.execution.terminated = true;
          report.execution.terminationVerified = Number.isInteger(exitCode);
          if (!report.execution.terminationVerified) {
            throw new Error(`Worker termination returned an invalid exit code: ${String(exitCode)}`);
          }
        } catch (terminationError) {
          report.status = 'error'; report.matched = false;
          report.behavior.status = 'error'; report.behavior.matched = false;
          report.error = {code: 'TERMINATION_FAILED', message: terminationError.message};
        } finally {
          clearTimeout(timer);
        }
      }
      report.execution.elapsedMs = Date.now() - startedAt;
      resolve(report);
    };
    const deadline = setTimeout(() => {
      void finish('timeout', {code: 'TIMEOUT', message: `Verification worker exceeded ${timeoutMs} ms and was terminated`});
    }, timeoutMs);
    try {
      // Owned structured bytes only; never transfer a caller's buffer or accept paths.
      const originalCopy = Uint8Array.from(original);
      const recoveredCopy = Uint8Array.from(recovered);
      worker = new Worker(new URL('./verify-worker.mjs', import.meta.url), {
        workerData: {originalData: originalCopy, recoveredData: recoveredCopy, allowExecute: true, maxSteps,
          originalCompiledProject, focusScript},
        transferList: [originalCopy.buffer, recoveredCopy.buffer],
        resourceLimits: {...VERIFY_LIMITS.resourceLimits}, env: {}, execArgv: [], stdout: true, stderr: true
      });
      report.execution.started = true;
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on('message', message => {
        if (settled || !message || !['progress', 'result'].includes(message.type)) return;
        for (const key of ['hashes', 'engine', 'adapters', 'structural', 'recompile', 'runs', 'scenario']) {
          if (message.report?.[key]) report[key] = message.report[key];
        }
        if (message.type === 'progress' && message.report?.behavior) {
          report.behavior = {...message.report.behavior, matched: false};
        }
        if (message.type === 'result') {
          report.status = message.report.status;
          report.behavior = message.report.behavior;
          report.matched = report.status === 'matched' && report.behavior?.matched === true;
          report.error = message.report.error || null;
          void finish();
        }
      });
      worker.on('error', error => {
        void finish('error', {code: error.code || 'WORKER_ERROR', message: error.message});
      });
      worker.on('exit', code => {
        if (!settled) void finish('error', {code: 'WORKER_EXIT', message: `Verification worker exited without a result (code ${code})`});
      });
    } catch (error) {
      void finish('error', {code: error.code || 'WORKER_START_FAILED', message: error.message});
    }
  });
}
