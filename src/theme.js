// Design tokens, adapted from Pivot's own src/routes/layout.css (its
// "Skin tokens" block) and src/lib/ui/skin.svelte.ts. Two skins — Flat
// (crisp cards, hairline borders) and Soft (neumorphic, shadow-only depth)
// — each with light/dark halves, selected via [data-skin]/[data-theme] on
// <html>, same mechanism Pivot itself uses. Values are carried over where
// the source was read directly; the soft-skin dark half wasn't in the
// portion read, so it's approximated in the same spirit (see the comment
// on `--ground: #2a2f3a`, which IS a real value from Pivot's source).
import { css } from "../fried.js";

const TOKENS_CSS = `
:root {
  --radius-panel: 1rem;
  --ground: #f1f5f9; --surface: #ffffff; --surface-sunken: #f1f5f9; --surface-hover: #f8fafc;
  --edge: #e2e8f0; --edge-hover: #cbd5e1;
  --chrome: #ffffff; --chrome-edge: #e2e8f0;
  --ink: #0f172a; --ink-secondary: #475569; --ink-muted: #5d6b80;
  --accent: #2563eb; --action-bg: #1e293b; --action-ink: #ffffff; --action-bg-hover: #334155;
  --card-elev: none; --card-elev-hover: none;
  --elev-overlay: 0 1px 1px rgba(15,23,42,.04), 0 8px 16px -8px rgba(15,23,42,.25);
}
:root[data-skin="flat"][data-theme="dark"] {
  --ground: #020617; --surface: #0f172a; --surface-sunken: #1e293b; --surface-hover: #1e293b;
  --edge: #334155; --edge-hover: #475569;
  --chrome: #0f172a; --chrome-edge: #334155;
  --ink: #f1f5f9; --ink-secondary: #cbd5e1; --ink-muted: #8b99ad;
  --accent: #60a5fa; --action-bg: #e2e8f0; --action-ink: #0f172a; --action-bg-hover: #cbd5e1;
  --elev-overlay: 0 1px 2px rgba(0,0,0,.5), 0 10px 20px -8px rgba(0,0,0,.7);
}
:root[data-skin="soft"] {
  --radius-panel: 1.25rem;
  --ground: #e4e2ec; --surface: #e4e2ec; --surface-sunken: #dedbe8; --surface-hover: #f4f2fb;
  --edge: transparent; --edge-hover: transparent;
  --chrome: var(--ground); --chrome-edge: rgba(83,78,110,.14);
  --ink: #1e293b; --ink-secondary: #475569; --ink-muted: #525e73;
  --accent: #3c4fc4; --action-bg: var(--accent); --action-ink: #ffffff; --action-bg-hover: #3343ae;
  --shadow-light: #f7f6fc; --shadow-dark: #c0bdd0;
  --card-elev: 5px 5px 13px var(--shadow-dark), -5px -5px 13px var(--shadow-light);
  --card-elev-hover: 11px 11px 26px var(--shadow-dark), -3px -3px 8px var(--shadow-light);
  --elev-overlay: 7px 7px 18px var(--shadow-dark), -7px -7px 18px var(--shadow-light);
}
:root[data-skin="soft"][data-theme="dark"] {
  /* Soft's dark ground is a mid-tone, not near-black: a lighter highlight
     and a darker shade both need somewhere to go, and #2a2f3a (the real
     value from Pivot's layout.css) is what makes both possible. */
  --ground: #2a2f3a; --surface: #2a2f3a; --surface-sunken: #262b34; --surface-hover: #313644;
  --ink: #e2e8f0; --ink-secondary: #b8c2d4; --ink-muted: #8d97a8;
  --accent: #7c93ff; --action-bg: var(--accent); --action-ink: #0f172a; --action-bg-hover: #93a5ff;
  --shadow-light: #363c49; --shadow-dark: #1d2129;
  --card-elev: 5px 5px 13px var(--shadow-dark), -5px -5px 13px var(--shadow-light);
  --card-elev-hover: 11px 11px 26px var(--shadow-dark), -3px -3px 8px var(--shadow-light);
  --elev-overlay: 7px 7px 18px var(--shadow-dark), -7px -7px 18px var(--shadow-light);
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  transition: background .15s ease, color .15s ease;
}
.wikilink { color: var(--accent); text-decoration: none; cursor: pointer; font-weight: 600; }
.wikilink:hover { text-decoration: underline; }
`;

let injected = false;
export function ensureTokens() {
  if (injected) return;
  injected = true;
  const el = document.createElement("style");
  el.id = "pivot-tokens";
  el.textContent = TOKENS_CSS;
  document.head.appendChild(el);
}

export function shellStyles() {
  ensureTokens();
  return css({
    nav: "display:flex; align-items:center; gap:4px; padding:10px 24px; background:var(--chrome); border-bottom:1px solid var(--chrome-edge); position:sticky; top:0; z-index:10;",
    brand: "font-weight:700; margin-right:auto; color:var(--ink);",
    tab: "background:none; border:none; padding:8px 14px; border-radius:8px; cursor:pointer; color:var(--ink-secondary); font-size:.9rem;",
    tabActive: "background:var(--surface); border:1px solid var(--edge); box-shadow:var(--card-elev); color:var(--ink); font-weight:600; padding:7px 13px; border-radius:8px; cursor:pointer; font-size:.9rem;",
  });
}

export function dayStyles() {
  ensureTokens();
  return css({
    layout: "display:grid; grid-template-columns: 1fr 320px; gap:24px; align-items:start; max-width:1100px; margin:0 auto; padding:24px;",
    main: "display:flex; flex-direction:column; gap:16px; min-width:0;",
    header: "display:flex; align-items:center; gap:10px;",
    title: "font-size:1.2rem; font-weight:600; flex:1; margin:0;",
    navBtn: "background:var(--surface); border:1px solid var(--edge); box-shadow:var(--card-elev); color:var(--ink); border-radius:8px; width:32px; height:32px; cursor:pointer; font-size:.9rem;",
    todayBtn: "background:var(--action-bg); color:var(--action-ink); border:none; border-radius:8px; padding:0 14px; height:32px; cursor:pointer; font-size:.85rem; font-weight:600;",
    composer: "display:flex; gap:8px;",
    input: "flex:1; padding:10px 14px; border-radius:var(--radius-panel); border:1px solid var(--edge); box-shadow:var(--card-elev); background:var(--surface); color:var(--ink); font-size:.95rem; outline:none;",
    sendBtn: "background:var(--action-bg); color:var(--action-ink); border:none; border-radius:var(--radius-panel); padding:0 20px; cursor:pointer; font-weight:600;",
    hint: "color:var(--ink-muted); font-size:.78rem; margin:0;",
    entries: "display:flex; flex-direction:column; gap:10px;",
    empty: "color:var(--ink-muted); font-size:.9rem; padding:32px 0; text-align:center; border:1px dashed var(--edge); border-radius:var(--radius-panel);",
    card: "display:flex; align-items:flex-start; gap:10px; background:var(--surface); border:1px solid var(--edge); border-radius:var(--radius-panel); box-shadow:var(--card-elev); padding:12px 14px;",
    dot: "width:11px; height:11px; border-radius:50%; margin-top:5px; cursor:pointer; flex-shrink:0; border:1px solid var(--edge-hover);",
    text: "flex:1; color:var(--ink); font-size:.95rem; line-height:1.5; word-break:break-word; white-space:pre-wrap;",
    del: "background:none; border:none; color:var(--ink-muted); cursor:pointer; font-size:1.1rem; line-height:1; padding:0 2px;",
    side: "position:sticky; top:80px;",
  });
}

export function calendarStyles() {
  ensureTokens();
  return css({
    cal: "background:var(--surface); border:1px solid var(--edge); box-shadow:var(--card-elev); border-radius:var(--radius-panel); padding:14px;",
    calHeader: "display:flex; align-items:center; gap:8px; margin-bottom:10px;",
    calLabel: "flex:1; text-align:center; font-weight:600; font-size:.9rem; color:var(--ink);",
    calNav: "background:none; border:none; color:var(--ink-secondary); cursor:pointer; font-size:1rem; width:24px; height:24px;",
    calWeekRow: "display:grid; grid-template-columns:repeat(7,1fr); margin-bottom:4px;",
    calWeekday: "text-align:center; font-size:.7rem; color:var(--ink-muted); text-transform:uppercase;",
    calGrid: "display:flex; flex-direction:column; gap:2px;",
    calRow: "display:grid; grid-template-columns:repeat(7,1fr); gap:2px;",
    calDay: "position:relative; aspect-ratio:1; display:flex; align-items:center; justify-content:center; background:none; border:none; border-radius:8px; cursor:pointer; color:var(--ink);",
    calDayOut: "color:var(--ink-muted); opacity:.45;",
    calDaySelected: "background:var(--action-bg); color:var(--action-ink);",
    calDayToday: "font-weight:700;",
    calDayNum: "font-size:.78rem;",
    calDayDot: "position:absolute; bottom:3px; width:4px; height:4px; border-radius:50%; background:var(--accent);",
  });
}

export function stringStyles() {
  ensureTokens();
  return css({
    wrap: "max-width:900px; margin:0 auto; padding:24px;",
    title: "font-size:1.2rem; font-weight:600; margin:0 0 4px;",
    hint: "color:var(--ink-muted); font-size:.85rem; margin:0 0 16px;",
    empty: "color:var(--ink-muted); font-size:.9rem; padding:60px 0; text-align:center; border:1px dashed var(--edge); border-radius:var(--radius-panel);",
    svg: "width:100%; height:auto; background:var(--surface); border:1px solid var(--edge); box-shadow:var(--card-elev); border-radius:var(--radius-panel);",
    // Not `--edge`/`--edge-hover`: those are `transparent` throughout the
    // Soft skin (it draws borders with shadow, not lines) which would make
    // every graph connection invisible there. A graph edge carries meaning
    // on its own, independent of the skin's border language, so it reads
    // off `--ink-muted` instead, which has a real color in every skin.
    edge: "stroke:var(--ink-muted); stroke-opacity:.4; stroke-width:1.5;",
    node: "cursor:pointer;",
    dayNode: "fill:var(--action-bg); stroke:var(--surface); stroke-width:2;",
    conceptNode: "fill:var(--accent); stroke:var(--surface); stroke-width:2;",
    nodeLabel: "font-size:11px; fill:var(--ink-secondary); text-anchor:middle;",
  });
}

export function settingsStyles() {
  ensureTokens();
  return css({
    wrap: "max-width:700px; margin:0 auto; padding:24px; display:flex; flex-direction:column; gap:28px;",
    title: "font-size:1.2rem; font-weight:600; margin:0;",
    section: "display:flex; flex-direction:column; gap:10px;",
    sectionTitle: "font-size:.95rem; font-weight:600; margin:0; color:var(--ink);",
    hint: "color:var(--ink-muted); font-size:.82rem; margin:0;",
    row: "display:flex; gap:10px; flex-wrap:wrap;",
    choice: "background:var(--surface); border:1px solid var(--edge); border-radius:var(--radius-panel); padding:10px 14px; cursor:pointer; display:flex; flex-direction:column; gap:2px; text-align:left; color:var(--ink); min-width:140px;",
    choiceActive: "background:var(--surface); border:2px solid var(--accent); box-shadow:var(--card-elev); border-radius:var(--radius-panel); padding:9px 13px; cursor:pointer; display:flex; flex-direction:column; gap:2px; text-align:left; color:var(--ink); min-width:140px;",
    choiceDesc: "font-size:.75rem; color:var(--ink-muted); font-weight:400;",
    catList: "display:flex; flex-direction:column; gap:8px;",
    catRow: "display:flex; align-items:center; gap:10px; background:var(--surface); border:1px solid var(--edge); border-radius:10px; padding:8px 10px;",
    catStars: "width:32px; color:var(--accent); font-weight:700;",
    swatch: "width:28px; height:28px; border:none; background:none; padding:0; cursor:pointer;",
    catLabel: "flex:1; border:1px solid var(--edge); border-radius:6px; padding:6px 8px; background:var(--surface); color:var(--ink); font-size:.9rem;",
    dangerBtn: "align-self:flex-start; background:none; border:1px solid #ef4444; color:#ef4444; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:.85rem;",
  });
}
