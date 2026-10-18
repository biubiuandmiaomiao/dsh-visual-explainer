/**
 * 「先解释名词，再画图」这一轮的纯逻辑（不碰 fs、不依赖 Harness，可直接单测）：
 *
 *  - `normalizeTerms()`        清洗模型给的名词数组：缺解释直接报错，重复去重
 *  - `formatTermsMarkdown()`   生成可原样放进回答开头的「第 0 轮」解释文字
 *  - `shouldBlockRender()`     画图前的门禁：名词轮还没做，就不让渲染
 *
 * @module dsh-visual-explainer/terms
 */

/** 一轮最多解释多少个名词；再多说明这次讲解该拆开。 */
export const MAX_TERMS = 12;

/** 名词本身最长多少字符（防止把整句话塞进 term）。 */
const MAX_TERM_LENGTH = 40;

/**
 * 取一个可用的字符串值。
 * @param {unknown} value - 模型给的原始值。
 * @returns {string} 去掉首尾空白后的字符串，非字符串返回空串。
 */
function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 清洗模型给的名词数组。缺 `term` / `plain` 直接报错，并说清楚怎么补。
 * @param {unknown} raw - 模型传入的 terms 参数。
 * @returns {{terms: Array<{term: string, plain: string, context: string, analogy: string, pitfall: string}>, dropped: number}}
 *   规范化后的名词，以及被去重掉的数量。
 * @throws {Error} 参数不合法时。
 */
export function normalizeTerms(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('terms 必须是数组：每个元素形如 { term, plain, context?, analogy?, pitfall? }');
  }
  if (raw.length > MAX_TERMS) {
    throw new Error(`一轮最多解释 ${MAX_TERMS} 个名词（收到 ${raw.length} 个）：先解释最关键的几个，其余放到下一轮。`);
  }

  /** @type {Array<{term: string, plain: string, context: string, analogy: string, pitfall: string}>} */
  const terms = [];
  const seen = new Set();
  let dropped = 0;

  raw.forEach((item, index) => {
    const where = `terms[${index}]`;
    if (typeof item === 'string') {
      throw new Error(
        `${where} 只有名词「${item.trim()}」，缺少 plain（一句大白话解释）。`
        + '名词轮是给不懂的人看的，只列名字没有意义。',
      );
    }
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${where} 必须是对象 { term, plain, context?, analogy?, pitfall? }`);
    }

    const term = asText(item.term);
    const plain = asText(item.plain);
    if (term.length === 0) throw new Error(`${where}.term 不能为空`);
    if (term.length > MAX_TERM_LENGTH) {
      throw new Error(`${where}.term 太长（${term.length} > ${MAX_TERM_LENGTH}）：只填名词本身，不要塞一整句话。`);
    }
    if (plain.length === 0) {
      throw new Error(`${where}「${term}」缺少 plain：用一句人话说明这个词在本篇里是什么意思。`);
    }

    const key = term.toLowerCase().replace(/\s+/gu, ' ');
    if (seen.has(key)) {
      dropped += 1;
      return;
    }
    seen.add(key);
    terms.push({
      term,
      plain,
      context: asText(item.context),
      analogy: asText(item.analogy),
      pitfall: asText(item.pitfall),
    });
  });

  return { terms, dropped };
}

/**
 * 生成「第 0 轮：名词解释」的 markdown，模型可以原样贴到回答最前面（所有图之前）。
 * @param {object} input - 名词轮内容。
 * @param {string} [input.topic] - 本次讲解的主题，作为标题后缀。
 * @param {Array<object>} input.terms - `normalizeTerms()` 的结果。
 * @param {string} [input.note] - `terms` 为空时的说明。
 * @returns {string} markdown 文本。
 */
export function formatTermsMarkdown({ topic, terms, note }) {
  const subject = asText(topic);
  const heading = subject.length > 0 ? `### 先解释名词：${subject}` : '### 先解释名词';

  if (!Array.isArray(terms) || terms.length === 0) {
    const reason = asText(note) || '本篇没有需要额外解释的专业/技术名词。';
    return `${heading === '### 先解释名词' ? '### 名词检查' : `${heading}（无）`}\n\n${reason}`;
  }

  const lines = terms.map((item) => {
    let line = `- **${item.term}**：${item.plain}`;
    if (item.context && item.context.length > 0) line += `（在本篇里：${item.context}）`;
    if (item.analogy && item.analogy.length > 0) line += ` 类比：${item.analogy}`;
    if (item.pitfall && item.pitfall.length > 0) line += ` 别混淆：${item.pitfall}`;
    return line;
  });

  return [heading, '', ...lines].join('\n');
}

/**
 * 画图前的门禁：返回 `null` 表示放行，返回字符串表示要抛给模型看的错误说明。
 * @param {object} input - 门禁输入。
 * @param {boolean} input.termsFirst - 插件配置：是否强制先解释名词。
 * @param {boolean} input.hasTermsRound - 本进程里是否已经做过名词轮。
 * @param {boolean} input.skipTerms - 本次调用是否显式要求跳过。
 * @returns {string | null} 拒绝原因，或 null。
 */
export function shouldBlockRender({ termsFirst, hasTermsRound, skipTerms }) {
  if (!termsFirst || skipTerms) return null;
  if (hasTermsRound) return null;
  return [
    '先解释名词，再画图：本轮还没有做名词解释（第 0 轮）。',
    '请先调用 visual_terms，把要讲的专业/技术名词逐个写成 { term, plain, context? }；它的返回里有一段可以直接放在回答最前面的解释文字。',
    '这一步做完，再调用 visual_explain 画对应的图。',
    '确实没有需要解释的名词时，用 visual_terms({ terms: [], note: "…" }) 明确说明；或给 visual_explain 传 skipTerms: true 跳过（重渲染旧图时用）。',
  ].join('\n');
}
