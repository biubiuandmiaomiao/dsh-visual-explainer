# Changelog

## 0.2.2

Current release.

- Four tools: `visual_terms`, `visual_template`, `visual_explain`,
  `visual_interactive`.
- `visual_interactive`: offline, clickable mermaid explainer page —
  `scaffold` writes `index.html` + local `mermaid.min.js`, `check` renders every
  step through headless Chrome/Edge and reports which step failed.
- Plugin-registered skill (`skill.md`): the "explain a diagram to a beginner"
  playbook, loaded on demand.
- Terms-first gate (`termsFirst`, on by default): `visual_explain` refuses to
  render until a `visual_terms` round has happened in the same process.
- Diagnostics in `%TEMP%\dsh-visual-explainer-status.json` (version, registered
  tools, last render, gate rejections).

## 0.1.x

- First public shape: terms round (`visual_terms`) → PNG cards
  (`visual_explain`), plus the optional starter template (`visual_template`).
- Per-card height measurement through Chrome headless mode; one PNG per
  `<section id="fgN">`; no bottom whitespace.
- `terms.md` / `terms.json` archives and the render gate.
