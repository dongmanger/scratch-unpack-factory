// 动态解密端到端测试：合成"打包产物"（内含 window.vm 桩），验证
// 服务 → 拦截 window.vm → 等待加载 → saveProjectSb3 → 字节落盘 的整条链路。
// （真实产物的 window.vm 赋值点已在两家 packager 源码中确认，桩仅替代重量级运行时。）
import { strict as assert } from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dynamicExtract } from '../src/dynamic-extract.mjs';
import * as H from './helpers.mjs';

const { bytes } = await H.makeMinimalSb3();
const b64 = Buffer.from(bytes).toString('base64');

const runCase = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

await runCase('单文件 HTML（TW chunk 容器 + vm 桩 toJSON/saveProjectSb3）', async () => {
  const { project } = await H.makeMinimalSb3();
  const container = H.buildTwHtmlV4(bytes); // 真实容器外观：静态侧供资产
  const pjB64 = Buffer.from(JSON.stringify(project)).toString('base64');
  const stub = new TextEncoder().encode(
    `<script>
const PJ_B64 = "${pjB64}";
const SB3_B64 = "${Buffer.from(bytes).toString('base64')}";
setTimeout(() => {
  const bin = Uint8Array.from(atob(SB3_B64), (c) => c.charCodeAt(0));
  window.vm = {
    runtime: { targets: [{ isStage: true, getName: () => 'Stage' }] },
    toJSON: () => decodeURIComponent(escape(atob(PJ_B64))),
    saveProjectSb3: async (type) =>
      type === 'arraybuffer' ? bin.slice().buffer : new Blob([bin])
  };
}, 150);
</script>`
  );
  // 把桩追加进容器 HTML 的 </body> 前
  const containerText = new TextDecoder().decode(container);
  const mergedHtml = new TextEncoder().encode(
    containerText.replace('</body>', new TextDecoder().decode(stub) + '</body>')
  );
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-dyn-'));
  const file = path.join(dir, 'artifact.html');
  await fsp.writeFile(file, mergedHtml);
  const { projectJSON, data } = await dynamicExtract(file, { timeoutMs: 30000 });
  assert.ok(projectJSON, 'toJSON 未返回');
  assert.ok(Buffer.from(data).equals(Buffer.from(bytes)), 'saveProjectSb3 兜底字节不一致');
  await fsp.rm(dir, { recursive: true, force: true });
});

await runCase('目录（zip 环境：页面 fetch ./project.zip）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-dyn-'));
  await fsp.writeFile(
    path.join(dir, 'index.html'),
    new TextEncoder().encode(
      `<!doctype html><html><body><script>
fetch('./project.zip').then((r) => r.arrayBuffer()).then((b) => {
  window.vm = {
    runtime: { targets: [{ isStage: true, getName: () => 'Stage' }] },
    saveProjectSb3: async (type) => (type === 'arraybuffer' ? b : new Blob([b]))
  };
});
</script></body></html>`
    )
  );
  await fsp.writeFile(path.join(dir, 'project.zip'), bytes);
  const { data } = await dynamicExtract(dir, { timeoutMs: 30000 });
  assert.ok(Buffer.from(data).equals(Buffer.from(bytes)), '抽取字节与原始 sb3 不一致');
  await fsp.rm(dir, { recursive: true, force: true });
});

console.log('动态解密 E2E 完成');
