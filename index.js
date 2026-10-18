/**
 * Host half of `dsh-visual-explainer`.
 *
 * Registers three agent tools that implement the "explain the jargon first, then draw"
 * protocol and turn a plain HTML "card deck" into PNGs the agent can embed in a reply:
 *
 *   - `visual_terms`    explains the professional/technical terms first (the "round 0"
 *                       that must happen before any picture), and archives terms.md/json
 *   - `visual_template` writes the starter HTML (canvas, tokens, measurement script)
 *   - `visual_explain`  writes the supplied HTML and renders one PNG per `<section id="fgN">`;
 *                       refuses to render until `visual_terms` has run (unless skipped)
 *
 * Rendering happens through the local Chrome/Edge headless mode, so this plugin adds
 * no dependency and makes no network call. Every stage is recorded in
 * `%TEMP%\dsh-visual-explainer-status.json`, because a tool that silently fails is
 * indistinguishable from a model that forgot to call it.
 *
 * @module dsh-visual-explainer
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { renderAll, templateHtml } from './renderer.mjs';
import { locateInteractivePage, runInteractiveCheck, scaffoldInteractive } from './lib/interactive.mjs';
import { MAX_TERMS, formatTermsMarkdown, normalizeTerms, shouldBlockRender } from './lib/terms.mjs';

/** Stable cordis plugin identity. */
export const name = 'visual-explainer';

/** The tool registry is the only hard dependency. */
export const inject = ['tools', 'skills'];

/** This package's version, so the status file says which build is live. */
let PLUGIN_VERSION = '0.0.0';
try {
  PLUGIN_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
} catch {
  PLUGIN_VERSION = '0.0.0';
}

/** Ground-truth status file. */
const DIAG_PATH = join(tmpdir(), 'dsh-visual-explainer-status.json');

/**
 * Merge one patch into the status file, atomically. Diagnostics never affect a call.
 * @param {object} patch - fields to record.
 * @returns {void}
 */
function writeDiag(patch) {
  try {
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(DIAG_PATH, 'utf8'));
    } catch {
      previous = {};
    }
    const next = { ...previous, ...patch, pid: process.pid, updatedAt: new Date().toISOString() };
    const temporary = `${DIAG_PATH}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
    renameSync(temporary, DIAG_PATH);
  } catch {
    /* diagnostics never fail a call */
  }
}

/** Shipped defaults; a profile patch only overrides what it cares about. */
export const Config = z.object({
  outDir: z.string().default('.dsh-visual'),
  scale: z.number().default(2),
  width: z.number().default(1240),
  browser: z.string().default(''),
  maxCards: z.number().default(12),
  termsFirst: z.boolean().default(true),
  explainerDir: z.string().default('.dsh-explain'),
});

/**
 * Resolve a user-supplied path against the session workspace.
 * @param {string} cwd - session working directory.
 * @param {string} value - absolute or workspace-relative path.
 * @returns {string} absolute path.
 */
function resolvePath(cwd, value) {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/**
 * Read the session working directory without assuming the call shape.
 * @param {object} exec - tool execution context.
 * @returns {string} absolute directory.
 */
function cwdOf(exec) {
  const fromSession = exec?.agent?.session?.header?.cwd;
  return typeof fromSession === 'string' && fromSession.length > 0 ? fromSession : process.cwd();
}

/**
 * Register the terms, template and render tools on the agent tool registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - agent-scoped services.
 * @param {ReturnType<typeof Config>} config - resolved plugin config.
 */
export function apply(ctx, config) {
  const settings = {
    outDir: config?.outDir ?? '.dsh-visual',
    scale: Number(config?.scale) > 0 ? Number(config.scale) : 2,
    width: Number(config?.width) > 0 ? Number(config.width) : 1240,
    browser: typeof config?.browser === 'string' ? config.browser : '',
    maxCards: Number(config?.maxCards) > 0 ? Number(config.maxCards) : 12,
    termsFirst: config?.termsFirst !== false,
    explainerDir: typeof config?.explainerDir === 'string' && config.explainerDir.trim().length > 0
      ? config.explainerDir.trim()
      : '.dsh-explain',
  };

  /**
   * The "round 0" record for this process: `visual_explain` refuses to draw until
   * one exists. Process-local on purpose — after a restart the first explain run
   * goes through the terms round again.
   */
  const termsState = {
    hasRound: false,
    termCount: 0,
    mdPath: '',
  };

  /** @type {Record<string, boolean>} */
  const registered = { visual_terms: false, visual_template: false, visual_explain: false, visual_interactive: false, skill: false };

  // 讲解手册：按需加载的技能；正文每次现读，改 skill.md 即热生效。
  try {
    if (typeof ctx.skills?.registerProvider === 'function') {
      const skillFile = fileURLToPath(new URL('./skill.md', import.meta.url));
      const skillDir = dirname(skillFile);
      const candidate = {
        name: 'explain-with-interactive-mermaid',
        description:
          '把一张图（时序图/流程图/架构图）讲成代码小白也能听懂的内容，并做成可点的离线 mermaid 交互页：'
          + '先解名词 → 再分层人话 → 再 mermaid（每条消息 ≤10 汉字）→ 再交互页 → 无头浏览器自检 → 交付源码与文件。',
        whenToUse:
          '当用户丢来一张图或一段专业流程，要求翻译、解释、可视化、做成图、用 mermaid 画、做成可交互页面，或说「代码小白也能听懂」时。',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'visual-explainer',
        provider: 'visual-explainer',
        rank: 470,
        path: skillFile,
        resourceBase: { kind: 'directory', path: skillDir },
        locator: { path: skillFile },
      };
      ctx.skills.registerProvider(() => ({
        name: 'visual-explainer',
        async list() {
          return [candidate];
        },
        async get(selected) {
          try {
            return { ...candidate, content: readFileSync(selected?.locator?.path ?? skillFile, 'utf8') };
          } catch {
            return undefined;
          }
        },
      }));
      registered.skill = true;
    }
  } catch (error) {
    writeDiag({ skillRegisterError: String(error?.message ?? error) });
  }


  try {
    ctx.tools.register(defineTool({
      name: 'visual_terms',
      description:
        '讲解的第 0 轮：在画任何图之前，先把本次讲解里的专业名词、技术名词逐个解释成人话。'
        + '每个词给 term（名词本身）与 plain（一句大白话解释，别用别的术语解释术语），可选 context（在本篇里指什么、出现在哪张图）、'
        + 'analogy（类比）、pitfall（常见误解）。返回一段 markdown，模型把它放在回答最前面（所有 PNG 之前），并写入 outDir 下的 terms.md / terms.json。'
        + `一次最多 ${MAX_TERMS} 个词；真的没有名词要解释时传 terms: [] 并用 note 说明。`
        + 'visual_explain 会检查这一步是否做过：没做名词轮就不让画图。',
      parameters: {
        topic: {
          type: 'string',
          description: '本次讲解的主题，用作这段解释的标题。例如「Chrome 无头渲染的三步」。',
        },
        terms: {
          type: 'array',
          required: true,
          description:
            '要解释的名词，按读者会先遇到的顺序排列。每个元素 { term, plain, context?, analogy?, pitfall? }。'
            + '真的不需要解释时传空数组 []，并用 note 说明原因。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              term: { type: 'string', required: true, description: '名词本身，如 RAG、向量检索、CORS、headless。' },
              plain: {
                type: 'string',
                required: true,
                description: '一句大白话解释：完全不懂的人也能听懂，不要用别的术语解释术语。',
              },
              context: { type: 'string', description: '在本篇讲解 / 后面哪张图里，这个词具体指什么。' },
              analogy: { type: 'string', description: '可选的类比，例如「像图书馆按意思找书」。' },
              pitfall: { type: 'string', description: '可选的常见误解：说明它不是什么。' },
            },
          },
        },
        note: { type: 'string', description: '当 terms 为空时，说明为什么本轮没有名词需要解释。' },
        outDir: {
          type: 'string',
          description: 'terms.md / terms.json 的输出目录。默认与 visual_explain 相同的 outDir。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            markdown: { type: 'string', required: true },
            mdPath: { type: 'string', required: true },
            jsonPath: { type: 'string', required: true },
            termCount: { type: 'integer', required: true },
            dropped: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const lines = [
            value.termCount === 0
              ? `名词轮已记录：本轮没有需要解释的名词${value.dropped > 0 ? `（去重 ${value.dropped} 个重复输入）` : ''}。现在可以画图了。`
              : `名词解释已就绪（第 0 轮，${value.termCount} 个词${value.dropped > 0 ? `，去重 ${value.dropped} 个` : ''}）。`,
          ];
          if (value.termCount > 0) {
            lines.push('把下面这段原样放在回答最前面（任何图之前），再调用 visual_explain 画对应的图；画完后把 PNG 紧接在这段文字后面。');
          }
          lines.push(
            '',
            value.markdown,
            '',
            `已存档：${value.mdPath}`,
            '下一步：visual_explain({ html, outDir })。图里的节点/步骤要与上面解释过的名词一一对应，不要在图上引入没解释过的新名词。',
          );
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const cwd = cwdOf(exec);
        const outDir = resolvePath(cwd, args.outDir?.trim() || settings.outDir);
        const note = typeof args.note === 'string' ? args.note.trim() : '';
        const { terms, dropped } = normalizeTerms(args.terms);
        if (terms.length === 0 && note.length === 0) {
          throw new Error('没有名词可解释时也要说明原因：传 terms: [] 并写 note，例如 note: "本篇只讲操作步骤，没有需要解释的专业术语。"');
        }

        const markdown = formatTermsMarkdown({ topic: args.topic, terms, note });
        await mkdir(outDir, { recursive: true });
        const mdPath = join(outDir, 'terms.md');
        const jsonPath = join(outDir, 'terms.json');
        const createdAt = new Date().toISOString();
        await writeFile(mdPath, `${markdown}\n`, 'utf8');
        await writeFile(jsonPath, `${JSON.stringify({
          topic: typeof args.topic === 'string' ? args.topic.trim() : '',
          note,
          terms,
          dropped,
          createdAt,
        }, null, 2)}\n`, 'utf8');

        termsState.hasRound = true;
        termsState.termCount = terms.length;
        termsState.mdPath = mdPath;

        writeDiag({
          lastTermsAt: createdAt,
          lastTermsCount: terms.length,
          lastTermsMdPath: mdPath,
          lastTermsOutDir: outDir,
          lastTermsDropped: dropped,
        });

        return { markdown, mdPath, jsonPath, termCount: terms.length, dropped };
      },
    }));
    registered.visual_terms = true;
  } catch (error) {
    writeDiag({ termsRegisterError: String(error?.message ?? error) });
  }

  try {
    ctx.tools.register(defineTool({
      name: 'visual_template',
      description:
        'Write the starter HTML for a visual explainer into the workspace and return its path. '
        + 'Use this (after the visual_terms round) before visual_explain when you need the card markup and design tokens: the file '
        + 'contains the 1240px canvas, the semantic colour variables, section isolation CSS, a term→figure mapping card '
        + 'example, and the height-reporting script the renderer depends on. Read it, replace the example cards, then '
        + 'call visual_explain with the finished HTML.',
      parameters: {
        path: {
          type: 'string',
          description: 'Where to write the starter file. Relative paths use the session working directory. Defaults to explain.html.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Wrote the explainer template to ${value.path} (${value.bytes} bytes).` }],
      },
      async execute(args, exec) {
        const cwd = cwdOf(exec);
        const target = resolvePath(cwd, args.path?.trim() || 'explain.html');
        const source = templateHtml();
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, source, 'utf8');
        writeDiag({ lastTemplateAt: new Date().toISOString(), lastTemplatePath: target });
        return { path: target, bytes: Buffer.byteLength(source, 'utf8') };
      },
    }));
    registered.visual_template = true;
  } catch (error) {
    writeDiag({ templateRegisterError: String(error?.message ?? error) });
  }

  try {
    ctx.tools.register(defineTool({
      name: 'visual_explain',
      description:
        '第二步，画图：把讲解 HTML 按卡片渲染成 PNG。调用前必须先完成「第 0 轮」——用 visual_terms 解释专业/技术名词'
        + '（否则本工具会拒绝并提示先解释名词）；名词轮的那段解释文字放在回答开头，这里返回的 PNG 立刻接在它后面。'
        + 'Each card must be a <section id="fg1">, "fg2", … element; the local Chrome headless mode screenshots each one at its '
        + 'exact measured height. Use this whenever the user asks for 图解 / 可视化 / 一张图看懂 / "show it '
        + 'visually". One card must carry one conclusion, every number or error string in it must be quoted from real output, '
        + 'and every term used on a card must be one visual_terms already explained.',
      parameters: {
        html: {
          type: 'string',
          required: true,
          description: 'Complete HTML source. Cards are <section id="fgN"> elements; the renderer screenshots each separately.',
        },
        outDir: {
          type: 'string',
          description: 'Output directory for the HTML and PNGs. Relative paths use the session working directory.',
        },
        prefix: {
          type: 'string',
          description: 'Output filename prefix. Defaults to the HTML file basename.',
        },
        skipTerms: {
          type: 'boolean',
          description:
            '跳过名词轮检查，默认 false。仅用于重渲染旧图、或视觉与名词无关时；第一次讲解新内容不要用——先调用 visual_terms。',
        },
        scale: {
          type: 'integer',
          description: 'Device pixel ratio: 2 renders a 1240px canvas at 2480px wide (default), 1 is lighter, 3 is slide quality.',
        },
        figs: {
          type: 'string',
          description: 'Only render these cards, comma separated, e.g. "1,3". Omit to render every card found.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            html: { type: 'string', required: true },
            figures: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                  bytes: { type: 'integer', required: true },
                },
              },
            },
            failed: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const termsLine = termsState.hasRound
            ? (termsState.termCount > 0
              ? `先名词后画图：第 0 轮已解释 ${termsState.termCount} 个名词（${termsState.mdPath}）。`
              : '先名词后画图：第 0 轮已确认本轮没有需要解释的名词。')
            : '先名词后画图：本次用 skipTerms 跳过了名词轮。';
          const lines = [termsLine];
          if (value.figures.length === 0) {
            lines.push(`No PNG was produced (${value.failed} failed). Source: ${value.html}`);
          } else {
            lines.push(`${value.figures.length} card image(s) rendered:\n${value.figures
              .map((figure) => `- ${figure.path}  (${figure.width}x${figure.height}, ${(figure.bytes / 1024).toFixed(0)} KB)`)
              .join('\n')}`);
            lines.push('把名词解释那段放在回答开头，紧跟这些图（![caption](path)）；顺序不要反过来。');
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const cwd = cwdOf(exec);
        const source = typeof args.html === 'string' ? args.html : '';
        if (source.trim().length === 0) throw new Error('visual_explain requires non-empty html');

        const blocked = shouldBlockRender({
          termsFirst: settings.termsFirst,
          hasTermsRound: termsState.hasRound,
          skipTerms: args.skipTerms === true,
        });
        if (blocked !== null) {
          writeDiag({
            lastGateRejectionAt: new Date().toISOString(),
            lastGateRejectionReason: 'terms-first',
            lastGateRejectedHtmlBytes: Buffer.byteLength(source, 'utf8'),
          });
          throw new Error(blocked);
        }

        const outDir = resolvePath(cwd, args.outDir?.trim() || settings.outDir);
        const prefix = args.prefix?.trim() || 'explain';
        const scale = Number(args.scale) > 0 ? Number(args.scale) : settings.scale;
        const figs = typeof args.figs === 'string' && args.figs.trim().length > 0
          ? args.figs.split(',').map((item) => item.trim()).filter(Boolean)
          : undefined;

        await mkdir(outDir, { recursive: true });
        const htmlPath = join(outDir, `${prefix}.html`);
        await writeFile(htmlPath, source, 'utf8');

        const startedAt = Date.now();
        const rows = await renderAll({
          htmlPath,
          outDir,
          prefix,
          scale,
          width: settings.width,
          figs,
          browser: settings.browser,
          maxCards: settings.maxCards,
        });

        const figures = rows
          .filter((row) => row.ok && row.file !== null)
          .map((row) => ({ id: row.id, path: row.file, width: row.pxWidth, height: row.pxHeight, bytes: row.bytes }));
        const failed = rows.length - figures.length;

        writeDiag({
          lastRenderAt: new Date().toISOString(),
          lastRenderMs: Date.now() - startedAt,
          lastHtmlPath: htmlPath,
          lastOutDir: outDir,
          lastScale: scale,
          lastCardIds: rows.map((row) => row.id),
          lastFailures: failed,
          lastFigurePaths: figures.map((figure) => figure.path),
          lastRenderTermsCount: termsState.termCount,
          lastRenderTermsMdPath: termsState.mdPath,
          lastRenderSkippedTerms: !termsState.hasRound,
        });

        return { html: htmlPath, figures, failed };
      },
    }));
    registered.visual_explain = true;
  } catch (error) {
    writeDiag({ explainRegisterError: String(error?.message ?? error) });
  }

  try {
    ctx.tools.register(defineTool({
      name: 'visual_interactive',
      description:
        '可点的讲解页（第三种形态）：当用户要「可交互 / 点着看 / 一步一步」时用它，而不是 PNG 卡片。'
        + 'action=scaffold：在工作区写出一页可双击打开的离线页面——左侧步骤条、右侧每一步的 mermaid 图、'
        + '下方一句大白话、源码可折叠、支持自动播放与 #sN 深链，自带本地 mermaid.min.js（不联网、不装依赖）。'
        + 'action=check：用无头 Chrome/Edge 打开该页的 #selftest，把「哪一步的图没画出来」报回来。'
        + '推荐顺序：先 visual_terms 解名词 → 再 scaffold → 改 index.html 里的 steps → 再 check → 最后在回答里给出页面路径与截图。'
        + '注意：每一步要一张独立的小图，不要让 mermaid 源码做「增量显示」——alt 没闭合会直接 parse 失败。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'scaffold=生成/覆盖交互页；check=用无头浏览器跑该页的 #selftest 自检。',
        },
        dir: {
          type: 'string',
          description: `页面所在/输出目录，相对会话工作目录（可给绝对路径）。默认 ${settings.explainerDir}。`,
        },
        title: { type: 'string', description: 'scaffold 时页面大标题。' },
        subtitle: { type: 'string', description: 'scaffold 时标题下的一句说明。' },
        formula: { type: 'string', description: 'scaffold 时右上角那句话（一句话总览）。' },
        force: { type: 'boolean', description: 'scaffold 时若 index.html 已存在是否覆盖，默认 false。' },
        browser: { type: 'string', description: 'check 时指定浏览器绝对路径，覆盖插件配置/CHROME_PATH。' },
        timeoutMs: { type: 'integer', description: 'check 时浏览器超时毫秒，默认 30000，范围 5000–120000。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            written: { type: 'boolean', required: true },
            pagePath: { type: 'string', required: true },
            mermaidPath: { type: 'string', required: true },
            mermaidBytes: { type: 'integer', required: true },
            browser: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            passed: { type: 'integer', required: true },
            failures: { type: 'array', required: true, items: { type: 'string' } },
            nextSteps: { type: 'array', required: true, items: { type: 'string' } },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const lines = [];
          if (value.action === 'scaffold') {
            if (!value.written) {
              lines.push(`没有覆盖：${value.pagePath}`);
              lines.push(value.reason || '目录里已有 index.html；确认覆盖时传 force: true。');
            } else {
              lines.push('交互讲解页已生成：');
              lines.push(`- 页面：${value.pagePath}`);
              lines.push(`- 引擎：${value.mermaidPath}（${Math.round(value.mermaidBytes / 1024)} KB，离线）`);
              lines.push('下一步：');
              for (const step of value.nextSteps) lines.push(`  · ${step}`);
              lines.push('改完调用 visual_interactive({ action: "check", dir }) 自检，再把页面路径和截图放进回答。');
            }
            return [{ type: 'text', text: lines.join('\n') }];
          }

          if (value.ok) {
            lines.push(`自检通过：${value.passed}/${value.total} 张图渲染成功`);
            lines.push(`浏览器：${value.browser}`);
            lines.push(`页面：${value.pagePath}`);
          } else {
            lines.push(`自检未通过：${value.passed}/${value.total} 通过`);
            if (value.browser) lines.push(`浏览器：${value.browser}`);
            lines.push(`页面：${value.pagePath}`);
            if (value.reason) lines.push(`原因：${value.reason}`);
            for (const failure of value.failures) lines.push(`  ✗ ${failure}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const cwd = cwdOf(exec);
        const action = args?.action;
        if (action !== 'scaffold' && action !== 'check') {
          throw new Error('action 必须是 scaffold 或 check');
        }

        if (action === 'scaffold') {
          const result = scaffoldInteractive({
            base: cwd,
            dir: args.dir?.trim() || settings.explainerDir,
            title: args.title,
            subtitle: args.subtitle,
            formula: args.formula,
            force: args.force === true,
          });
          writeDiag({
            lastInteractiveScaffoldAt: new Date().toISOString(),
            lastInteractivePage: result.pagePath,
            lastInteractiveWritten: result.written,
          });
          return {
            action,
            ok: result.written,
            written: result.written,
            pagePath: result.pagePath,
            mermaidPath: result.mermaidPath,
            mermaidBytes: result.mermaidBytes,
            browser: '',
            total: 0,
            passed: 0,
            failures: [],
            nextSteps: result.nextSteps,
            reason: result.reason ?? '',
          };
        }

        const pagePath = locateInteractivePage(args.dir?.trim() || settings.explainerDir, cwd);
        if (!pagePath) {
          return {
            action,
            ok: false,
            written: false,
            pagePath: '',
            mermaidPath: '',
            mermaidBytes: 0,
            browser: '',
            total: 0,
            passed: 0,
            failures: [],
            nextSteps: [],
            reason: `在 ${args.dir?.trim() || settings.explainerDir} 里没找到 index.html；先跑 action="scaffold"`,
          };
        }

        const startedAt = Date.now();
        const result = runInteractiveCheck({
          pagePath,
          browser: args.browser?.trim() || settings.browser,
          timeoutMs: args.timeoutMs,
        });
        writeDiag({
          lastInteractiveCheckAt: new Date().toISOString(),
          lastInteractiveCheckMs: Date.now() - startedAt,
          lastInteractiveCheckOk: result.ok,
          lastInteractiveCheckPage: pagePath,
          lastInteractiveCheckBrowser: result.browser,
          lastInteractiveCheckFailures: result.failures,
        });

        return {
          action,
          ok: result.ok,
          written: false,
          pagePath,
          mermaidPath: '',
          mermaidBytes: 0,
          browser: result.browser ?? '',
          total: result.total ?? 0,
          passed: result.passed ?? 0,
          failures: result.failures ?? [],
          nextSteps: [],
          reason: result.reason ?? '',
        };
      },
    }));
    registered.visual_interactive = true;
  } catch (error) {
    writeDiag({ interactiveRegisterError: String(error?.message ?? error) });
  }

  writeDiag({
    pluginVersion: PLUGIN_VERSION,
    reloadProbe: 'hot-reload-probe-1',
    appliedAt: new Date().toISOString(),
    config: settings,
    toolsRegistered: registered,
    hasTools: typeof ctx.tools?.register === 'function',
  });
}
