/**
 * visual_interactive 的冒烟测试：脚手架写出页面、页面自检能跑通。
 * 不 import index.js（它依赖宿主包），只测 lib/interactive.mjs。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  existingBrowsers,
  locateInteractivePage,
  runInteractiveCheck,
  scaffoldInteractive,
} from '../lib/interactive.mjs';

test('scaffoldInteractive 写出可离线打开的页面', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vi-scaffold-'));
  const result = scaffoldInteractive({ dir, title: '测试 <标题>', subtitle: '副标题' });

  assert.equal(result.written, true);
  assert.ok(result.pagePath.endsWith('index.html'));
  assert.ok(result.mermaidBytes > 1_000_000, '应带上本地 mermaid 引擎');

  const html = readFileSync(result.pagePath, 'utf8');
  assert.match(html, /测试 &lt;标题&gt;/, '标题要转义后写进页面');
  assert.match(html, /src="\.\/mermaid\.min\.js"/, '必须引用本地引擎');
  assert.match(html, /pre\.id = 'selftest'/, '必须保留 #selftest 自检入口');

  const second = scaffoldInteractive({ dir });
  assert.equal(second.written, false, '默认不覆盖已有页面');
  assert.equal(locateInteractivePage(dir), result.pagePath);
});

test('页面自检全绿（需要本机 Chrome/Edge）', (t) => {
  if (existingBrowsers().length === 0) {
    t.skip('本机没有 Chrome/Edge');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-vi-check-'));
  const result = scaffoldInteractive({ dir });
  const check = runInteractiveCheck({ pagePath: result.pagePath, timeoutMs: 60_000 });

  assert.equal(check.ok, true, JSON.stringify({ failures: check.failures, attempts: check.attempts }));
  assert.ok(check.total >= 4, `模板至少有 4 张图，实际 ${check.total}`);
  assert.equal(check.failures.length, 0);
});
