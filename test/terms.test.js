import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TERMS,
  formatTermsMarkdown,
  normalizeTerms,
  shouldBlockRender,
} from '../lib/terms.mjs';

test('a term without a plain-language explanation is rejected, not silently dropped', () => {
  assert.throws(() => normalizeTerms([{ term: 'RAG' }]), /RAG.*缺少 plain/u);
  assert.throws(() => normalizeTerms(['RAG']), /只有名词「RAG」/u);
  assert.throws(() => normalizeTerms([{ term: ' ', plain: 'x' }]), /term 不能为空/u);
  assert.throws(() => normalizeTerms([{ term: 'A'.repeat(41), plain: 'x' }]), /太长/u);
  assert.throws(() => normalizeTerms('RAG'), /必须是数组/u);
});

test('terms are trimmed, deduplicated case-insensitively, and optional fields default to empty', () => {
  const { terms, dropped } = normalizeTerms([
    { term: ' RAG ', plain: ' 先检索、再生成 ', context: ' 本篇的检索步 ', analogy: '', pitfall: undefined },
    { term: 'rag', plain: '重复的那个' },
    { term: 'CORS', plain: '浏览器跨域规则' },
  ]);
  assert.equal(dropped, 1);
  assert.deepEqual(terms.map((item) => item.term), ['RAG', 'CORS']);
  assert.equal(terms[0].plain, '先检索、再生成');
  assert.equal(terms[0].context, '本篇的检索步');
  assert.equal(terms[0].analogy, '');
  assert.equal(terms[0].pitfall, '');
});

test('one round cannot explain more than MAX_TERMS terms', () => {
  const raw = Array.from({ length: MAX_TERMS + 1 }, (_, index) => ({ term: `T${index}`, plain: 'x' }));
  assert.throws(() => normalizeTerms(raw), new RegExp(`最多解释 ${MAX_TERMS} 个`, 'u'));
});

test('the glossary markdown leads with the term, then the plain meaning and context', () => {
  const { terms } = normalizeTerms([
    {
      term: 'headless',
      plain: '没有窗口的浏览器',
      context: '第 2 张图的截图步骤',
      analogy: '像后台运行的打印机',
      pitfall: '不是"无界面就不渲染"',
    },
  ]);
  const markdown = formatTermsMarkdown({ topic: '渲染三步', terms });

  assert.match(markdown, /^### 先解释名词：渲染三步/mu);
  assert.match(markdown, /\*\*headless\*\*：没有窗口的浏览器/u);
  assert.match(markdown, /在本篇里：第 2 张图的截图步骤/u);
  assert.match(markdown, /类比：像后台运行的打印机/u);
  assert.match(markdown, /别混淆：不是"无界面就不渲染"/u);
});

test('an empty terms round still produces a check section when a note explains why', () => {
  const markdown = formatTermsMarkdown({ terms: [], note: '本篇只讲操作步骤，没有专业术语。' });
  assert.match(markdown, /^### 名词检查/mu);
  assert.match(markdown, /本篇只讲操作步骤/u);
});

test('the render gate blocks until a terms round happened, and every escape hatch works', () => {
  const blocked = shouldBlockRender({ termsFirst: true, hasTermsRound: false, skipTerms: false });
  assert.ok(blocked !== null);
  assert.match(blocked, /先解释名词，再画图/u);
  assert.match(blocked, /visual_terms/u);

  assert.equal(shouldBlockRender({ termsFirst: true, hasTermsRound: true, skipTerms: false }), null);
  assert.equal(shouldBlockRender({ termsFirst: true, hasTermsRound: false, skipTerms: true }), null);
  assert.equal(shouldBlockRender({ termsFirst: false, hasTermsRound: false, skipTerms: false }), null);
});
