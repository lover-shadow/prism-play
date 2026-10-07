import { inlineThemeStyles, inlineDayPaletteStyles } from './theme';

/** Serve as /admin/assets/app.css, not an inline style block. */
export const adminStyles = `${inlineThemeStyles()}\n${inlineDayPaletteStyles()}
:root { color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { color-scheme: light; } }
body { padding: var(--safe-top) var(--space-4) var(--safe-bottom); }
.top { max-width: var(--container-desktop); margin: auto; display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-5) 0; border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: var(--space-2); text-decoration: none; font-weight: 700; }
.brand span { color: var(--fg-2); font-weight: 400; }
.admin-shell { max-width: var(--container-desktop); margin: auto; padding: var(--space-6) 0 var(--space-12); }
.login { max-width: var(--container-mobile); margin: var(--space-10) auto; padding: var(--space-8); }
.eyebrow { color: var(--accent); letter-spacing: var(--tracking-caps); font-size: var(--text-xs); }
h1 { font: 700 var(--text-xl)/var(--leading-tight) var(--font-display); }
h2 { font-size: var(--text-lg); } h3 { font-size: var(--text-base); }
.subtle, caption { color: var(--fg-2); font-size: var(--text-sm); }
nav, .actions, .section-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
.section-head { justify-content: space-between; }
nav { padding: var(--space-3) 0; } nav a { color: var(--fg-2); text-decoration: none; padding: var(--space-2); }
a:hover { color: var(--accent); }
button, input, select, textarea { font: inherit; border-radius: var(--radius-sm); border: 1px solid var(--border); }
button { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: var(--touch-target); padding: var(--space-2) var(--space-4); background: var(--surface-raised); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-on); border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .55; cursor: not-allowed; }
button:hover:not(:disabled) { border-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
label { display: flex; flex-direction: column; gap: var(--space-2); color: var(--fg-2); font-size: var(--text-sm); min-width: 0; }
input, select, textarea { background: var(--bg); color: var(--fg); padding: var(--space-3); min-height: var(--touch-target); width: 100%; }
input[type=checkbox] { width: var(--space-5); min-height: var(--space-5); accent-color: var(--accent); }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,180px),1fr)); align-items: end; gap: var(--space-3); }
summary { cursor: pointer; color: var(--accent); min-height: var(--touch-target); padding: var(--space-2) 0; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,170px),1fr)); gap: var(--space-3); }
.metric { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-raised); padding: var(--space-4); }
.metric strong { display: block; color: var(--accent); font-size: var(--text-xl); margin-top: var(--space-2); }
.table-wrap { overflow: auto; } table { width: 100%; border-collapse: collapse; text-align: left; font-size: var(--text-sm); }
caption { text-align: left; padding: var(--space-2) 0; }
th, td { padding: var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--fg-2); font-weight: 500; white-space: nowrap; }
td { overflow-wrap: anywhere; min-width: 100px; } td .actions { min-width: 200px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-sm); color: var(--fg-2); }
#message:not(:empty) { border-left: 2px solid var(--accent); background: var(--accent-subtle); padding: var(--space-3); margin-bottom: var(--space-4); }
dialog { margin: auto; width: min(calc(100% - 32px),600px); max-height: calc(100% - 32px); overflow: auto; padding: var(--space-6); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: var(--fg); }
dialog::backdrop { background: var(--surface-overlay); }
@media (max-width: 600px) { .brand { flex-wrap: wrap; } .brand span { flex-basis: 100%; } .panel { padding: var(--space-3); } .login { padding: var(--space-5); } .section-head { align-items: flex-start; } }
`;
