// Inject this authored harness through the official browser API in a loaded
// TurboWarp editor. It loads bytes only; it never starts downloaded scripts.
export function startBrowserAssetCheck({file, label, saveRoundtrip = true}) {
  const api = 'http://127.0.0.1:8766';
  window.__factoryAssetCheck = {status: 'loading', file, label};
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const compare = async (expected, project) => {
    const vm = window.vm;
    const issues = [], targets = [];
    for (const [index, target] of vm.runtime.targets.filter(target => target.isOriginal).entries()) {
      const source = project.targets[index];
      const item = {name: target.getName(), costumes: [], sounds: [], properties: {}};
      if (!source || target.getName() !== source.name || target.isStage !== source.isStage) issues.push({index, kind: 'target-ownership'});
      for (const key of ['currentCostume', 'volume', 'layerOrder', ...(target.isStage ? [] : ['x', 'y', 'size', 'direction', 'visible', 'rotationStyle', 'draggable'])]) {
        const actual = key === 'layerOrder' ? target.getLayerOrder() : target[key];
        item.properties[key] = actual;
        if (source?.[key] !== undefined && JSON.stringify(source[key]) !== JSON.stringify(actual)) issues.push({index, key, expected: source[key], actual});
      }
      for (const [kind, records] of [['costumes', target.getCostumes()], ['sounds', target.getSounds()]]) {
        if (records.length !== source?.[kind]?.length) issues.push({index, kind: `${kind}-count`});
        for (const [position, record] of records.entries()) {
          const original = source[kind][position];
          const filename = original.md5ext || `${original.assetId}.${original.dataFormat}`;
          const bytes = record.asset?.data;
          const result = {name: record.name, assetId: record.assetId, filename, bytes: bytes?.length || 0, broken: !!record.broken};
          if (!bytes || record.broken) issues.push({index, kind, position, reason: 'missing-or-broken'});
          else {
            result.sha256 = await hash(bytes);
            if (result.sha256 !== expected.assetHashes[filename]) issues.push({index, kind, position, reason: 'bytes-changed'});
          }
          if (record.name !== original.name) issues.push({index, kind, position, reason: 'name-normalized', expected: original.name, actual: record.name});
          if (kind === 'costumes') {
            for (const key of ['rotationCenterX', 'rotationCenterY', 'bitmapResolution']) {
              if (original[key] !== undefined && JSON.stringify(record[key]) !== JSON.stringify(original[key])) issues.push({index, kind, position, key, expected: original[key], actual: record[key]});
            }
            result.skinId = record.skinId;
            result.skinLoaded = Number.isInteger(record.skinId) && !!vm.runtime.renderer?._allSkins?.[record.skinId];
            if (!result.skinLoaded) issues.push({index, kind, position, reason: 'skin-not-created'});
          } else {
            const player = target.sprite.soundBank?.getSoundPlayer(record.soundId);
            result.soundId = record.soundId;
            result.decodedSamples = player?.buffer?.length || 0;
            if (!result.decodedSamples) issues.push({index, kind, position, reason: 'sound-not-decoded'});
            for (const key of ['rate', 'sampleCount']) {
              if (original[key] !== undefined && JSON.stringify(record[key]) !== JSON.stringify(original[key])) {
                if (result.decodedSamples > 0) {
                  (result.normalizations ||= []).push({key, expected: original[key], actual: record[key], reason: 'audio-context-decode-normalization'});
                } else issues.push({index, kind, position, key, expected: original[key], actual: record[key]});
              }
            }
          }
          item[kind].push(result);
        }
      }
      targets.push(item);
    }
    return {issues, targets, costumes: targets.reduce((sum, target) => sum + target.costumes.length, 0),
      sounds: targets.reduce((sum, target) => sum + target.sounds.length, 0)};
  };
  (async () => {
    try {
      window.vm.stopAll();
      const expected = await (await fetch(`${api}/expected.json?file=${encodeURIComponent(file)}`)).json();
      const bytes = await (await fetch(`${api}${file}`)).arrayBuffer();
      await window.vm.loadProject(bytes);
      const before = await compare(expected, expected.project);
      const evidence = {label, file, originalInputSha256: await hash(bytes), expectedInputSha256: expected.sha256,
        renderer: !!window.vm.runtime.renderer, audio: !!window.vm.runtime.audioEngine,
        scriptsStarted: false, before, status: 'loaded'};
      if (saveRoundtrip) {
        const saved = await (await window.vm.saveProjectSb3()).arrayBuffer();
        await window.vm.loadProject(saved);
        evidence.after = await compare(expected, expected.project);
        evidence.savedBytes = saved.byteLength;
        evidence.savedSha256 = await hash(saved);
      }
      await fetch(`${api}/evidence.json`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(evidence)});
      window.__factoryAssetCheck = {status: 'done', file, label, targets: before.targets.length, costumes: before.costumes,
        sounds: before.sounds, issues: before.issues, roundtripIssues: evidence.after?.issues, savedBytes: evidence.savedBytes};
    } catch (error) { window.__factoryAssetCheck = {status: 'error', error: String(error), stack: error.stack}; }
  })();
  return window.__factoryAssetCheck;
}
