import {restoreSb3} from './restore.mjs';

/** Container definitions and initial values are authoritative; runtime snapshots are evidence only. */
export async function mergeProjectJSON(projectJSON, containerZip) {
  const restored = await restoreSb3({staticResult: {type: 'sb3', format: 'zip-sb3', data: containerZip, notes: []},
    dynamicResult: {projectJSON}, format: 'zip-sb3'});
  return {data: restored.data, assets: restored.report.assets.length, report: restored.report};
}
