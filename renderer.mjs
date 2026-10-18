/**
 * Card renderer: HTML with `<section id="fgN">` blocks -> one PNG per card.
 *
 * Every card is measured first (Chrome renders it and reports its real content
 * height in `<title>`), then screenshotted at exactly that height, so a PNG never
 * carries a band of empty white underneath. No image library and no network: the
 * local Chrome / Edge headless mode does the work.
 *
 * Used two ways:
 *   - as a library: `import { renderAll, templateHtml } from './renderer.mjs'`
 *   - as a CLI:     `node renderer.mjs --html page.html --out figs`
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FALLBACK_HEIGHT = 900;
const MAX_BUFFER = 48 * 1024 * 1024;

/**
 * The starter stylesheet+markup shipped with this plugin.
 * @returns {string} template HTML source.
 */
export function templateHtml() {
  return readFileSync(new URL('./template.html', import.meta.url), 'utf8');
}

/**
 * Candidate browser executables, most likely first.
 * @returns {string[]} existing-or-not absolute paths.
 */
function browserCandidates() {
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
}

/**
 * Locate a browser that supports `--headless=new --screenshot`.
 * @param {string} [explicit] - configured override.
 * @returns {string} absolute browser path.
 * @throws when nothing is installed.
 */
export function findBrowser(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`配置的浏览器不存在: ${explicit}`);
    return explicit;
  }
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome 或 Edge。请在插件配置里设 browser，或设置环境变量 CHROME_PATH。');
}

/** Chrome flags shared by the measure and the shoot step. */
function baseFlags(profileDir, width) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${FALLBACK_HEIGHT}`,
  ];
}

/**
 * Render one URL offscreen and read the content height the page reported.
 * @returns {Promise<number>} measured CSS height, or 0 when the page reported nothing.
 */
async function measure(browser, url, profileDir, width) {
  try {
    const { stdout } = await run(browser, [...baseFlags(profileDir, width), '--dump-dom', url], {
      maxBuffer: MAX_BUFFER,
      timeout: 90_000,
      windowsHide: true,
    });
    const match = /<title>\s*h=(\d+)\s*<\/title>/i.exec(stdout);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** Screenshot one URL. Chrome's exit code is unreliable; the produced file is the truth. */
async function shoot(browser, url, outPath, profileDir, width, height, scale) {
  try {
    await run(
      browser,
      [...baseFlags(profileDir, width), `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, `--screenshot=${outPath}`, url],
      { maxBuffer: MAX_BUFFER, timeout: 90_000, windowsHide: true },
    );
  } catch {
    /* fall through: existence and size are checked next */
  }
  return existsSync(outPath) && statSync(outPath).size > 0;
}

/**
 * Read `id="fgN"` in document order.
 * @param {string} htmlPath - source file.
 * @returns {string[]} figure ids.
 */
export function discoverFigures(htmlPath) {
  const source = readFileSync(htmlPath, 'utf8');
  const ids = [...source.matchAll(/id="(fg\d+)"/g)].map((match) => match[1]);
  return [...new Set(ids)].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/**
 * Accept `2` as well as `fg2`: a bare number would become the anchor `#2`, which
 * matches no section and silently renders every card stacked into one image.
 * @param {string} value - user reference.
 * @returns {string} `fg`-prefixed id.
 */
export function normalizeFigure(value) {
  const trimmed = String(value).trim();
  return /^\d+$/u.test(trimmed) ? `fg${trimmed}` : trimmed;
}

/**
 * Render an explainer HTML into one PNG per card.
 * @param {object} options - render options.
 * @param {string} options.htmlPath - absolute source HTML.
 * @param {string} options.outDir - absolute output directory.
 * @param {string} [options.prefix] - output filename prefix (default: HTML basename).
 * @param {number} [options.scale] - device pixel ratio (default 2).
 * @param {number} [options.width] - canvas width in CSS px (default 1240).
 * @param {number} [options.height] - fixed height, skipping measurement.
 * @param {string[]} [options.figs] - subset of figure references.
 * @param {boolean} [options.whole] - one tall image instead of per-card.
 * @param {string} [options.browser] - browser override.
 * @param {number} [options.maxCards] - safety cap.
 * @returns {Promise<Array<object>>} one row per produced image.
 */
export async function renderAll(options) {
  const htmlPath = resolve(options.htmlPath);
  if (!existsSync(htmlPath)) throw new Error(`HTML 不存在: ${htmlPath}`);
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const scale = Number(options.scale) > 0 ? Number(options.scale) : 2;
  const width = Number(options.width) > 0 ? Number(options.width) : 1240;
  const fixedHeight = Number(options.height) > 0 ? Number(options.height) : 0;
  const maxCards = Number(options.maxCards) > 0 ? Number(options.maxCards) : 24;

  const browser = findBrowser(options.browser);
  const profileDir = join(tmpdir(), 'visual-explainer-chrome');
  const fileUrl = pathToFileURL(htmlPath).href;
  const prefix = options.prefix ?? basename(htmlPath, extname(htmlPath));

  const discovered = options.whole ? [] : (options.figs?.length ? options.figs : discoverFigures(htmlPath)).map(normalizeFigure);
  if (discovered.length > maxCards) throw new Error(`卡片太多（${discovered.length} > ${maxCards}），请合并或分批渲染`);
  const targets = discovered.length > 0
    ? discovered.map((id) => ({ id, hash: `#${id}`, file: join(outDir, `${prefix}-${id}.png`) }))
    : [{ id: null, hash: '', file: join(outDir, `${prefix}.png`) }];

  const rows = [];
  for (const target of targets) {
    const url = `${fileUrl}${target.hash}`;
    const measured = fixedHeight || await measure(browser, url, profileDir, width);
    const height = measured > 0 ? measured : FALLBACK_HEIGHT;
    const ok = await shoot(browser, url, target.file, profileDir, width, height, scale);
    rows.push({
      id: target.id ?? '(整页)',
      ok,
      file: ok ? target.file : null,
      cssWidth: width,
      cssHeight: height,
      pxWidth: width * scale,
      pxHeight: height * scale,
      bytes: ok ? statSync(target.file).size : 0,
    });
  }
  return rows;
}

/** Read the usage header out of this file so `--help` never drifts from the code. */
function usage() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  return source.split('*/')[0].replace(/^\/\*\*?/u, '').replace(/^ \* ?/gmu, '');
}

function parseArgs(argv) {
  const args = { scale: 2, width: 1240, out: 'figs', whole: false };
  const need = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--html') args.html = need(++i, flag);
    else if (flag === '--out') args.out = need(++i, flag);
    else if (flag === '--name') args.name = need(++i, flag);
    else if (flag === '--browser') args.browser = need(++i, flag);
    else if (flag === '--figs') args.figs = need(++i, flag).split(',').map((item) => item.trim()).filter(Boolean);
    else if (flag === '--width') args.width = Number(need(++i, flag));
    else if (flag === '--height') args.height = Number(need(++i, flag));
    else if (flag === '--scale') args.scale = Number(need(++i, flag));
    else if (flag === '--whole') args.whole = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数: ${flag}`);
  }
  return args;
}

async function cli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.html) throw new Error('缺少 --html');
  const rows = await renderAll({
    htmlPath: args.html,
    outDir: args.out,
    prefix: args.name,
    scale: args.scale,
    width: args.width,
    height: args.height,
    figs: args.figs,
    whole: args.whole,
    browser: args.browser,
  });
  const pad = (value, width) => String(value).padEnd(width);
  console.log(`${pad('卡片', 10)}${pad('结果', 6)}${pad('CSS', 13)}${pad('PNG', 15)}${pad('大小', 9)}文件`);
  let failed = 0;
  for (const row of rows) {
    if (!row.ok) failed += 1;
    console.log(
      `${pad(row.id, 10)}${pad(row.ok ? 'ok' : 'FAIL', 6)}${pad(`${row.cssWidth}x${row.cssHeight}`, 13)}`
      + `${pad(`${row.pxWidth}x${row.pxHeight}`, 15)}${pad(row.ok ? `${(row.bytes / 1024).toFixed(0)} KB` : '-', 9)}${row.file ?? '-'}`,
    );
  }
  if (failed > 0) {
    console.error(`\n${failed} 张失败。先确认浏览器能打开该 HTML，或改用 --height 900。`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}
