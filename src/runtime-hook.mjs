export const RUNTIME_HOOK = `
(() => {
  let vmVal = null;
  let projectLoaded = false;
  let timer;
  window.__factoryState = 'waiting-for-vm';
  window.__factorySnapshot = null;
  window.__factorySnapshotEvidence = null;
  window.__factoryHookErrors = [];
  const capture = (basis) => {
    if (window.__factorySnapshot !== null || !vmVal || typeof vmVal.toJSON !== 'function') return;
    try {
      const json = vmVal.toJSON();
      if (typeof json === 'string') {
        window.__factorySnapshot = json;
        window.__factorySnapshotEvidence = basis;
      }
    } catch (error) { window.__factoryHookErrors.push(String(error)); }
  };
  const settled = () => {
    if (!vmVal?.runtime || !Array.isArray(vmVal.runtime.targets) ||
        !vmVal.runtime.targets.some(t => t.isStage)) return false;
    return vmVal.runtime.targets.every(t => {
      if (!t.sprite) return true;
      return (t.sprite.costumes || []).every(c => c.broken || c.asset || typeof c.skinId === 'number') &&
        (t.sprite.sounds || []).every(s => s.broken || s.asset || s.soundId !== undefined);
    });
  };
  const check = () => {
    try {
      if (projectLoaded || settled()) {
        capture(projectLoaded ? 'PROJECT_LOADED-before-greenFlag' : 'settled-fallback-unverified');
        window.__factoryState = 'ready';
        clearInterval(timer);
        return true;
      }
    } catch (error) { window.__factoryHookErrors.push(String(error)); }
    return false;
  };
  const onVm = (value) => {
    vmVal = value;
    projectLoaded = false;
    window.__factoryState = 'vm-found';
    // Prevent autoplay from mutating original variables/lists/sprite state before the snapshot.
    for (const name of ['greenFlag', 'start']) {
      if (typeof value?.[name] === 'function') {
        try { value[name] = () => { window.__factoryHookErrors.push('autoplay-suppressed:' + name); }; }
        catch (error) { window.__factoryHookErrors.push(String(error)); }
      }
    }
    if (typeof value?.runtime?.on === 'function') {
      value.runtime.on('PROJECT_LOADED', () => {
        projectLoaded = true;
        capture('PROJECT_LOADED-before-greenFlag');
        check();
      });
    }
    if (!check()) {
      clearInterval(timer);
      timer = setInterval(check, 100);
      setTimeout(() => clearInterval(timer), 600000);
    }
  };
  const existing = window.vm;
  Object.defineProperty(window, 'vm', {configurable: true, get: () => vmVal, set: onVm});
  if (existing) onVm(existing);
})();
`;
