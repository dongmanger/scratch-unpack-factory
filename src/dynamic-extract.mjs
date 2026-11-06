// 可选运行时证据提取；容器初态优先于运行后序列化。
// 私有Scratch上下文可关闭window.vm暴露，此钩子不保证覆盖所有产物。
// zip 打包环境的产物先解压成目录再以 HTTP 服务，页面内的 ./project.zip 等相对请求自然生效。

import http from 'node:http';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {RUNTIME_HOOK as INIT_SCRIPT} from './runtime-hook.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/** 单文件或目录的本地 HTTP 服务 */
export const serveStatic = (rootPath) => {
  const stat = fsSync.statSync(rootPath);
  const isDir = stat.isDirectory();
  const root = fsSync.realpathSync(rootPath);
  const server = http.createServer(async (req, res) => {
    try {
      const requestPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (requestPath.includes('\\') || requestPath.includes('\0') ||
          requestPath.split('/').includes('..')) throw new Error('unsafe request');
      let filePath = isDir ? path.join(root, requestPath) : root;
      if (isDir) {
        const s = await fsp.stat(filePath).catch(() => null);
        if (s && s.isDirectory()) filePath = path.join(filePath, 'index.html');
        const resolved = await fsp.realpath(filePath);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('request outside artifact root');
        }
        filePath = resolved;
      }
      const data = await fsp.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
};

const isZip = (u8) => u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7);

const extractZipToTempDir = async (zipBytes) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-zip-'));
  const zip = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const original = file.unsafeOriginalName || name;
    if (original.startsWith('/') || /^[a-z]:/i.test(original) || /[\\\x00-\x1f]/.test(original) ||
        original.split('/').some(part => part === '..' || part === '.')) throw new Error('unsafe zip path');
    const outPath = path.join(dir, ...name.split('/'));
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, await file.async('uint8array'));
  }
  return dir;
};

const findEntryHtml = async (dir) => {
  const rels = [];
  const walk = async (rel, depth) => {
    if (depth > 2) return;
    for (const entry of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(r, depth + 1);
      else if (/\.(html?)$/i.test(entry.name)) rels.push(r);
    }
  };
  await walk('', 0);
  if (!rels.length) throw new Error('zip 环境中未找到任何 HTML 入口');
  rels.sort((a, b) => {
    const score = (p) => (path.basename(p).toLowerCase() === 'index.html' ? 0 : 1) * 10 + p.split(path.sep).length;
    return score(a) - score(b);
  });
  return rels[0];
};


/**
 * 动态抽取主入口。
 * @param {string} inputPath 产物路径（HTML 文件 / zip 包 / 目录）
 * @returns {Promise<{data: Uint8Array, info: object, logs: string[]}>}
 */
export const dynamicExtract = async (inputPath, { timeoutMs = 120000, headed = false } = {}) => {
  let tempDir = null;
  let server = null;
  let browser = null;
  const logs = [];

  try {
    let serveRoot;
    let entryRel = '';
    const stat = fsSync.statSync(inputPath);
    if (stat.isDirectory()) {
      serveRoot = inputPath;
      entryRel = await findEntryHtml(inputPath);
    } else {
      const head = new Uint8Array(await fsp.readFile(inputPath)).subarray(0, 4);
      if (head[0] === 0x4d && head[1] === 0x5a) {
        throw new Error('Windows 可执行（NW.js/Electron）暂不支持动态抽取；请先手动解出内嵌 zip/app.nw');
      }
      const bytes = new Uint8Array(await fsp.readFile(inputPath));
      if (isZip(bytes)) {
        tempDir = await extractZipToTempDir(bytes);
        serveRoot = tempDir;
        entryRel = await findEntryHtml(tempDir);
      } else {
        serveRoot = inputPath; // 单 HTML 文件
      }
    }

    server = await serveStatic(serveRoot);
    const url = entryRel ? `${server.url}/${entryRel.split(path.sep).join('/')}` : `${server.url}/`;

    const { chromium } = await import('playwright-core');
    let lastErr = null;
    for (const channel of ['chrome', 'msedge', 'chrome-canary', 'msedge-beta']) {
      try {
        browser = await chromium.launch({ channel, headless: !headed });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!browser) {
      throw new Error(`无法启动本机 Chrome/Edge: ${lastErr && lastErr.message}`);
    }

    const page = await browser.newPage();
    page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('requestfailed', (req) => logs.push(`[req-failed] ${req.url().slice(0, 120)} :: ${req.failure() && req.failure().errorText}`));
    page.on('requestfinished', (req) => {
      const url = req.url();
      if (!url.startsWith(server.url) || /project|asset|\.svg|\.png|\.wav|\.mp3/i.test(url)) {
        logs.push(`[req-ok] ${url.slice(0, 120)}`);
      }
    });

    await page.addInitScript(INIT_SCRIPT);
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => {
      logs.push(`[goto] ${e.message}`);
    });

    try {
      await page.waitForFunction(() => window.__factoryState === 'ready', undefined, { timeout: timeoutMs });
    } catch (e) {
      const state = await page.evaluate(() => window.__factoryState).catch(() => '?');
      const diag = await page
        .evaluate(() => {
          try {
            return {
              targets: window.vm.runtime.targets.map((t) => ({
                name: typeof t.getName === 'function' ? t.getName() : '?',
                costumes: (t.sprite ? t.sprite.costumes : []).map((c) => ({
                  name: c.name,
                  hasAsset: !!c.asset,
                  broken: !!c.broken,
                  hasSkin: !!c.skin,
                  md5: c.md5 || null
                })),
                sounds: (t.sprite ? t.sprite.sounds : []).map((s) => ({ name: s.name, hasAsset: !!s.asset }))
              }))
            };
          } catch (err) {
            return { diagErr: String(err) };
          }
        })
        .catch(() => null);
      throw new Error(
        `工程加载超时/失败（state=${state}）。诊断: ${JSON.stringify(diag)}\n最近页面日志:\n${logs.slice(-15).join('\n')}`
      );
    }

    // 工程语义真相：toJSON()（打包运行时 isPackaged 会清空内存资产，
    // saveProjectSb3 产出的 zip 天然缺资产文件——资产由混合模式从容器补全）
    const projectJSON = await page
      .evaluate(() => window.__factorySnapshot)
      .catch(() => null);
    const data = await page.evaluate(() =>
      window.vm.saveProjectSb3('arraybuffer').then((b) => new Uint8Array(b))
    );
    const info = await page.evaluate(() => {
      try {
        return {
          snapshotEvidence: window.__factorySnapshotEvidence,
          hookErrors: window.__factoryHookErrors || [],
          targets: window.vm.runtime.targets.map((t) => ({
            name: typeof t.getName === 'function' ? t.getName() : (t.target && t.target.name) || '?',
            isStage: !!t.isStage,
            blocks: t.blocks ? Object.keys(t.blocks._blocks || t.blocks).length : 0,
            costumes: (t.sprite ? t.sprite.costumes : []).map((c) => c.name),
            sounds: (t.sprite ? t.sprite.sounds : []).length
          }))
        };
      } catch (e) {
        return { targets: [] };
      }
    });

    await browser.close();
    browser = null;
    server.close();
    server = null;
    return { projectJSON, data, info, logs };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};
