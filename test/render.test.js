import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverFigures, normalizeFigure, renderAll, templateHtml } from '../renderer.mjs';

test('a bare figure number becomes an fg-prefixed id', () => {
  assert.equal(normalizeFigure('2'), 'fg2');
  assert.equal(normalizeFigure(' fg3 '), 'fg3');
  assert.equal(normalizeFigure('fg10'), 'fg10');
});

test('figures are discovered in numeric order', () => {
  const dir = mkdtempSync(join(tmpdir(), 've-discover-'));
  try {
    const htmlPath = join(dir, 'page.html');
    writeFileSync(htmlPath, [
      '<section id="fg2"></section>',
      '<section id="fg1"></section>',
      '<section id="fg10"></section>',
      '<div id="not-a-card"></div>',
    ].join('\n'));
    assert.deepEqual(discoverFigures(htmlPath), ['fg1', 'fg2', 'fg10']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the template renders one PNG per card at its own measured height', async () => {
  const dir = mkdtempSync(join(tmpdir(), 've-render-'));
  try {
    const htmlPath = join(dir, 'card.html');
    writeFileSync(htmlPath, templateHtml(), 'utf8');

    const rows = await renderAll({ htmlPath, outDir: join(dir, 'out'), scale: 1 });

    assert.equal(rows.length, 3, 'the template ships three example cards (flow, contrast, term→figure)');
    for (const row of rows) {
      assert.equal(row.ok, true, `${row.id} must render`);
      assert.ok(row.bytes > 5000, `${row.id} must not be an empty PNG`);
      assert.equal(statSync(row.file).size, row.bytes);
    }
    // Distinct heights prove the measurement runs per card rather than reusing the viewport.
    assert.notEqual(rows[0].cssHeight, rows[1].cssHeight);
    // The term→figure mapping card exists, so the "explain terms first, then draw" story has a card pattern.
    assert.deepEqual(rows.map((row) => row.id), ['fg1', 'fg2', 'fg3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
