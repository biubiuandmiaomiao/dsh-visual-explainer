/**
 * 交互讲解页：把「一张图 → 小白能懂 → 可点的 mermaid 页面」做成 visual-explainer 的第三个形态。
 *
 *  - `scaffoldInteractive()` 写出一页可双击打开的离线交互页（左侧步骤 / 右侧图 / #selftest）；
 *  - `runInteractiveCheck()` 用无头浏览器跑该页的 #selftest，回报每一步的图能不能渲染。
 *
 * 与 PNG 卡片（renderer.mjs）共用同一套「本地 Chrome/Edge、不联网」的取值：
 * 优先用插件配置里的 browser，其次 CHROME_PATH，最后扫常见安装路径；
 * Chrome 在某些机器上无头模式会报 "Multiple targets"，所以逐个候选试到出结果为止。
 *
 * @module dsh-visual-explainer/interactive
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('../assets/explainer-template.html', import.meta.url));
const MERMAID = fileURLToPath(new URL('../assets/mermaid.min.js', import.meta.url));

const MAX_BUFFER = 64 * 1024 * 1024;

/** 浏览器候选，按优先级排；第一个通常是 Chrome。 */
function browserCandidates(explicit) {
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    explicit,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter((item) => typeof item === 'string' && item.length > 0);
}

/** 返回所有实际存在的浏览器路径（去重、保序）。 */
export function existingBrowsers(explicit) {
  const seen = new Set();
  const result = [];
  for (const candidate of browserCandidates(explicit)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) result.push(candidate);
  }
  return result;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * 生成交互讲解页。
 * @param {{dir?: string, base?: string, title?: string, subtitle?: string, formula?: string, force?: boolean}} options
 * @returns {{written: boolean, pagePath: string, mermaidPath: string, mermaidBytes: number, reason?: string, nextSteps: string[]}}
 */
export function scaffoldInteractive(options = {}) {
  const base = typeof options.base === 'string' && options.base.length > 0 ? options.base : process.cwd();
  const dir = resolve(base, (options.dir ?? '').trim() || '.dsh-explain');
  const pagePath = join(dir, 'index.html');
  const mermaidPath = join(dir, 'mermaid.min.js');
  const nextSteps = [
    '编辑 index.html：改 header 的标题，改 const steps = [...] 里每一步的 title / plain / eng / code',
    '每条 mermaid 消息控制在 10 个汉字以内，细节写进 plain',
    '最后一项「全景图」对应 const FULL = {...}',
    '改完用 visual_interactive({ action: "check", dir }) 自检，再打开页面看效果',
  ];

  if (existsSync(pagePath) && options.force !== true) {
    return {
      written: false,
      pagePath,
      mermaidPath,
      mermaidBytes: 0,
      reason: '目录里已经有 index.html；确认覆盖时传 force: true',
      nextSteps,
    };
  }

  mkdirSync(dir, { recursive: true });

  const html = readFileSync(TEMPLATE, 'utf8')
    .replaceAll('{{TITLE}}', escapeHtml(options.title ?? '把这张图讲成小白能懂的版本'))
    .replaceAll('{{SUBTITLE}}', escapeHtml(options.subtitle ?? '每一步一张图 + 一句大白话；替换掉示例内容即可。'))
    .replaceAll('{{FORMULA}}', escapeHtml(options.formula ?? '先解名词 → 再讲人话 → 再画图 → 最后自检'));

  writeFileSync(pagePath, html, 'utf8');
  copyFileSync(MERMAID, mermaidPath);

  return {
    written: true,
    pagePath,
    mermaidPath,
    mermaidBytes: statSync(mermaidPath).size,
    nextSteps,
  };
}

/** 在目录里找讲解页（index.html / explain.html）。 */
export function locateInteractivePage(dirOrFile, base) {
  const root = typeof base === 'string' && base.length > 0 ? base : process.cwd();
  const target = resolve(root, (dirOrFile ?? '').trim() || '.dsh-explain');
  if (existsSync(target) && statSync(target).isFile()) return target;
  for (const name of ['index.html', 'explain.html']) {
    const candidate = join(target, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function decodeEntities(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * 跑一次页面自检。
 * @param {{pagePath: string, browser?: string, timeoutMs?: number}} options
 * @returns {{ok: boolean, pagePath: string, browser: string, total: number, passed: number, failures: string[], reason: string, attempts: Array<{browser: string, reason: string}>}}
 */
export function runInteractiveCheck({ pagePath, browser: explicit, timeoutMs = 30_000 }) {
  const browsers = existingBrowsers(explicit);
  const empty = { ok: false, pagePath, browser: '', total: 0, passed: 0, failures: [], reason: '', attempts: [] };

  if (browsers.length === 0) {
    return {
      ...empty,
      reason: '找不到 Chrome/Edge。请在插件配置里设 browser，或设环境变量 CHROME_PATH，或在会话里传 browser。',
    };
  }

  const url = pathToFileURL(pagePath).href + '#selftest';
  const attempts = [];
  const budget = Math.max(5_000, Math.min(120_000, Number(timeoutMs) || 30_000));

  for (const browser of browsers) {
    const profile = join(tmpdir(), 'dsh-visual-explainer-' + Math.random().toString(36).slice(2, 10));
    let result;
    try {
      result = spawnSync(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--mute-audio',
          '--user-data-dir=' + profile,
          '--virtual-time-budget=20000',
          '--dump-dom',
          url,
        ],
        { encoding: 'utf8', timeout: budget, maxBuffer: MAX_BUFFER, windowsHide: true },
      );
    } catch (error) {
      attempts.push({ browser, reason: String(error?.message ?? error) });
      continue;
    }

    const dom = result.stdout ?? '';
    const block = /<pre id="selftest">([\s\S]*?)<\/pre>/.exec(dom);
    if (!block) {
      // Chrome 在部分机器上报 "Multiple targets"，DOM 为空；记下来换下一个候选。
      const stderrTail = (result.stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ');
      attempts.push({ browser, reason: stderrTail || '页面没有产出 #selftest 结果' });
      continue;
    }

    const text = decodeEntities(block[1]);
    const passed = [...text.matchAll(/OK\s+step\s+(\d+)/g)].length;
    const failedLines = [...text.matchAll(/(?:BAD|FAIL)\s+step\s+(\d+)([^\n]*)/g)]
      .map((match) => `step ${match[1]}${match[2].trim() ? `: ${match[2].trim()}` : ''}`);
    const total = passed + failedLines.length;

    return {
      ok: failedLines.length === 0 && total > 0,
      pagePath,
      browser,
      total,
      passed,
      failures: failedLines,
      reason: total === 0 ? '页面里没有可渲染的步骤（steps 是空的？）' : '',
      attempts,
    };
  }

  return { ...empty, reason: '所有浏览器候选都没跑通，见 attempts', attempts };
}
