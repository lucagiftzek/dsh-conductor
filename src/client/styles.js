/**
 * Conductor stylesheet. Colours come only from the host's
 * --dsw-alias-* tokens and the tzekos theme's --tz-* variables, with
 * fallbacks that match the theme's dark values, so light and dark follow the
 * shell. Square corners everywhere, hairline rows, clay only for the primary
 * action and for unread or live state. Injected once into <head>.
 */
import { PLUGIN_ID } from './api.js'

export const STYLE_ID = PLUGIN_ID + '-styles'

const VARS = [
  '--ok:var(--dsw-alias-state-success-primary,#4f9d69)',
  '--warn:var(--dsw-alias-state-warn-primary,#c8952f)',
  '--bad:var(--dsw-alias-state-error-primary,#e0685a)',
  '--clay:var(--tz-accent,var(--dsw-alias-brand-primary,#c1553a))',
  '--on-clay:var(--tz-on-accent,var(--dsw-alias-label-primary-foreground,#fbf7f4))',
  '--blue:var(--tz-accent-2,#5e9bd6)',
  '--link:var(--dsw-alias-link,var(--tz-accent-2,#5e9bd6))',
  '--ink:var(--dsw-alias-label-primary,inherit)',
  '--ink2:var(--dsw-alias-label-secondary,inherit)',
  '--ink3:var(--dsw-alias-label-tertiary,inherit)',
  '--line:var(--dsw-alias-border-l2,rgba(128,128,128,.28))',
  '--line1:var(--dsw-alias-border-l1,rgba(128,128,128,.16))',
  '--base:var(--dsw-alias-bg-base,transparent)',
  '--l1:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#1b1817))',
  '--l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07))',
  '--l3:var(--dsw-alias-bg-layer-3,#2a2523)',
  '--hov:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))',
  '--sel:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.18))',
  '--mono:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)',
  '--ease:var(--tz-ease,cubic-bezier(.2,.7,.3,1))',
  '--pop:var(--tz-shadow-pop,6px 6px 0 rgba(0,0,0,.35))',
  '--c-system:repeating-linear-gradient(135deg,var(--dsw-static-neutral-bluish-600,#7d7470) 0 3px,color-mix(in srgb,var(--dsw-static-neutral-bluish-600,#7d7470) 40%,transparent) 3px 5px)',
  '--c-instr:var(--tz-accent-2,#5e9bd6)',
  '--c-handoff:var(--dsw-alias-state-success-secondary,#62ad7b)',
  '--c-msg:var(--dsw-alias-label-secondary,#c0b7b2)',
  '--c-tool:var(--tz-accent,#c1553a)',
].join(';')

export const CSS = `
.cdx{${VARS};position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  font:inherit;font-size:13px;line-height:1.4;color:var(--ink);container-type:inline-size;container-name:cdx}
.cdx *,.cdx-set *,.cdx-star *{box-sizing:border-box;border-radius:0}
.cdx :focus-visible,.cdx-set :focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-num{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums}
.cdx-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.cdx-grow{flex:1;min-width:0}
.cdx-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}

/* header: one line of numbers, a thin bar, the actions */
.cdx-head{flex:none;position:relative;padding:12px 14px 12px}
.cdx-meter{display:flex;flex-direction:column;gap:6px}
.cdx-mline{all:unset;box-sizing:border-box;display:flex;align-items:baseline;gap:8px;cursor:pointer;color:var(--ink2);align-self:flex-start;padding:1px 2px;margin:-1px -2px}
.cdx-mline:hover{color:var(--ink)}
.cdx-mline:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-mline .cdx-num{font-size:12px}
.cdx-mline b{color:var(--ink);font-weight:600;font-size:13px}
.cdx-pct{color:var(--ink3);font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
.cdx-pct.warn{color:var(--warn)}.cdx-pct.bad{color:var(--bad);font-weight:600}
.cdx-chev{flex:none;color:var(--ink3);display:inline-flex;transition:transform 120ms var(--ease)}
.cdx-thin{position:relative;height:3px;background:var(--l2)}
.cdx-thin>i{display:block;height:100%;background:var(--ink3);transition:width 180ms var(--ease)}
.cdx-thin.warn>i{background:var(--warn)}.cdx-thin.bad>i{background:var(--bad)}
.cdx-tick{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;background:var(--warn)}
.cdx-ltick{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--clay)}
.cdx-asum{all:unset;box-sizing:border-box;align-self:flex-start;max-width:100%;font-size:11.5px;line-height:16px;color:var(--ink3);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-asum:hover{color:var(--ink)}
.cdx-asum:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-breakdown{list-style:none;margin:2px 0 0;padding:0}
.cdx-brow{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:24px;padding:0 4px;font-size:12px;color:var(--ink2);cursor:pointer}
.cdx-brow:hover{background:var(--hov);color:var(--ink)}
.cdx-brow:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.cdx-brow.muted{cursor:default}.cdx-brow.muted:hover{background:transparent;color:var(--ink2)}
.cdx-brow.muted .cdx-sw{box-shadow:inset 0 0 0 1px var(--line)}
.cdx-chipbtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:0 6px;font-size:11.5px;color:var(--ink2);cursor:pointer;white-space:nowrap}
.cdx-chipbtn:hover{background:var(--hov);color:var(--ink)}
.cdx-chipbtn[aria-pressed=true]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--clay)}
.cdx-chipbtn:focus-visible{outline:2px solid var(--blue);outline-offset:0}
.cdx-sw{display:inline-block;width:8px;height:8px;flex:none}
.cdx-hint{padding:6px 8px;font-size:12px;line-height:1.45;border-left:2px solid var(--bad);background:var(--l2);color:var(--ink)}
.cdx-actions{display:flex;align-items:center;gap:6px;margin-top:12px}
.cdx-menuwrap{position:relative;display:inline-flex}
.cdx-menuwrap>.cdx-ibtn{width:28px;height:28px}
.cdx-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:30;min-width:200px;display:flex;flex-direction:column;padding:4px 0;background:var(--l3);border:1px solid var(--line);box-shadow:var(--pop)}
.cdx-mitem{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;min-height:30px;padding:0 12px;font-size:12.5px;color:var(--ink);cursor:pointer}
.cdx-mitem:hover,.cdx-mitem:focus{background:var(--hov);outline:none}
.cdx-mitem:focus-visible{box-shadow:inset 2px 0 0 var(--blue)}
.cdx-mitem[aria-disabled=true]{opacity:.45;cursor:not-allowed}
.cdx-mhint{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--ink3)}
.cdx-confirm{margin-top:12px;padding:10px 12px;border-left:2px solid var(--warn);background:var(--l2);font-size:12px;line-height:1.5}
.cdx-confirm .cdx-actions{margin-top:8px}
.cdx-progress{margin-top:12px;padding:10px 12px 12px;border-left:2px solid var(--clay);background:var(--l2);position:relative;overflow:hidden}
.cdx-ptitle{display:flex;align-items:baseline;gap:8px;font-weight:600}
.cdx-ptitle .cdx-num{margin-left:auto;font-weight:500;color:var(--ink2)}
.cdx-psub{font-size:12px;color:var(--ink2);margin-top:2px}
.cdx-indet{position:absolute;left:0;right:0;bottom:0;height:2px;overflow:hidden}
.cdx-indet::before{content:"";position:absolute;top:0;bottom:0;width:30%;background:var(--clay);animation:cdx-indet 1.3s var(--ease) infinite}
@keyframes cdx-indet{0%{left:-30%}100%{left:100%}}
.cdx-result{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:8px 6px 8px 12px;font-size:12px;line-height:1.5;border-left:2px solid var(--ok);background:var(--l2)}
.cdx-result.bad{border-left-color:var(--bad)}.cdx-result.warn{border-left-color:var(--warn)}
.cdx-result .cdx-links{display:flex;gap:14px;margin-top:3px;flex-wrap:wrap}

/* buttons and links */
.cdx-btn{font:inherit;font-size:12px;line-height:16px;min-height:26px;padding:4px 10px;border:1px solid var(--line);background:transparent;color:var(--ink);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background-color 120ms var(--ease)}
.cdx-btn:hover:not(:disabled){background:var(--hov)}
.cdx-btn:disabled{opacity:.45;cursor:not-allowed}
.cdx-btn.p{background:var(--clay);border-color:var(--clay);color:var(--on-clay);font-weight:600}
.cdx-btn.p:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--clay));filter:brightness(1.06)}
.cdx-btn.d{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 70%,transparent)}
.cdx-btn.g{border-color:transparent;color:var(--ink2)}
.cdx-btn.g:hover:not(:disabled){color:var(--ink)}
.cdx-btn.s{min-height:24px;padding:2px 8px;font-size:11.5px}
.cdx-ibtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;color:var(--ink3);cursor:pointer}
.cdx-ibtn:hover:not([aria-disabled=true]){background:var(--hov);color:var(--ink)}
.cdx-ibtn:focus-visible{outline:2px solid var(--blue);outline-offset:-1px}
.cdx-ibtn[aria-disabled=true]{opacity:.4;cursor:not-allowed}
.cdx-ibtn.on{color:var(--clay)}
.cdx-link{all:unset;box-sizing:border-box;color:var(--link);cursor:pointer;font-size:12px;line-height:18px}
.cdx-link:hover{text-decoration:underline}
.cdx-link:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-spacer{flex:1}

/* sub-tabs: one segmented bar, one panel */
.cdx-tabs{flex:none;display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.cdx-tabs [role=tab]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 8px;font-size:12.5px;color:var(--ink3);cursor:pointer;white-space:nowrap;
  box-shadow:inset 0 -2px 0 transparent;transition:color 120ms var(--ease),box-shadow 120ms var(--ease)}
.cdx-tabs [role=tab]:hover{color:var(--ink)}
.cdx-tabs [role=tab][aria-selected=true]{color:var(--ink);font-weight:600;box-shadow:inset 0 -2px 0 var(--ink)}
.cdx-tabs [role=tab]:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.cdx-tcount{font-family:var(--mono);font-size:10.5px;font-weight:500;color:var(--ink3);font-variant-numeric:tabular-nums}
.cdx-tcount.live{color:var(--clay);font-weight:600}
@container cdx (max-width:359px){.cdx-tabs{padding:0 4px}.cdx-tabs [role=tab]{padding:0 6px;font-size:12px}}

/* automation, checkpoints, recall */
.cdx-apart{display:flex;flex-direction:column;gap:8px;padding:6px 14px 12px;border-bottom:1px solid var(--line1)}
.cdx-apart:last-child{border-bottom:0}
.cdx-acustom{display:flex;flex-direction:column;gap:6px;padding-left:20px}
.cdx-cp.auto .cdx-title{color:var(--ink2)}
.cdx-cp.auto .cdx-title>span{font-weight:400}
.cdx-cp .cdx-title>span{font-weight:500}
.cdx-rewind{display:flex;flex-direction:column;gap:8px;margin:6px 0 2px;padding:10px 12px;border-left:2px solid var(--warn);background:var(--l2);font-size:12px}
.cdx-plan{display:flex;flex-direction:column;gap:4px}
.cdx-flist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font-family:var(--mono);font-size:11px}
.cdx-flist li{display:flex;gap:8px;justify-content:space-between;min-width:0}
.cdx-flist li.conflict{color:var(--warn)}
.cdx-lell{direction:rtl;text-align:left}
.cdx-flist .cdx-help{font-family:inherit;flex:none}
.cdx-check2{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink);cursor:pointer}
.cdx-check2.warn{color:var(--warn)}
.cdx-snippet{font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--ink2);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}

/* first-run setup guide */
.cdx-wizard{display:flex;flex-direction:column;gap:12px;padding:16px 14px 12px}
.cdx-wtop{display:flex;align-items:center;gap:10px}
.cdx-dots{display:flex;gap:6px;list-style:none;margin:0 0 0 auto;padding:0}
.cdx-dots li{width:8px;height:8px;background:var(--l2);box-shadow:inset 0 0 0 1px var(--line)}
.cdx-dots li.done{background:var(--ink3);box-shadow:none}
.cdx-dots li.on{background:var(--clay);box-shadow:none}
.cdx-wtitle{margin:0;font-size:15px;line-height:1.35;font-weight:600;color:var(--ink)}
.cdx-wtitle:focus{outline:none}
.cdx-wtitle:focus-visible{outline:none}
.cdx-wbody{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.55;color:var(--ink)}
.cdx-wbody p{margin:0}
.cdx-wlist{margin:0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:6px;color:var(--ink2)}
.cdx-wlist b{color:var(--ink);font-weight:600}
.cdx-wsub{margin:6px 0 0;font-size:11px;font-weight:600;color:var(--ink3)}
.cdx-wgroup{display:flex;flex-direction:column}
.cdx-wrow{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid var(--line1)}
.cdx-wrow:last-child{border-bottom:0}
.cdx-wrow .t{font-size:13px;color:var(--ink)}
.cdx-wrow .d{font-size:11.5px;color:var(--ink3);line-height:1.45}
.cdx-wrow .d.warn{color:var(--warn)}
.cdx-wrow .cdx-switch{margin-top:2px}
.cdx-wsecret{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-left:2px solid var(--ok);background:var(--l2);font-size:12px}
.cdx-wsecret .cdx-pre.log{white-space:pre-wrap;word-break:break-word;margin:0}
.cdx-wnav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px}
.cdx-wizard .cdx-note{margin:0}

/* panels */
.cdx-fallback{margin:12px 14px 0;padding:6px 10px;font-size:12px;line-height:1.5;color:var(--ink2);border-left:2px solid var(--warn);background:var(--l2)}
.cdx-meta.warn{color:var(--warn)}
.cdx-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1,var(--line)) transparent}
.cdx-body:focus{outline:none}
.cdx-phead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px 4px;min-height:32px}
.cdx-panelfoot{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 14px 12px}
.cdx-sub{display:flex;align-items:center;gap:8px;padding:14px 14px 4px;font-size:11px;font-weight:600;color:var(--ink3)}
.cdx-sub .cdx-btn,.cdx-sub .cdx-chipbtn{font-weight:500}

/* rows */
.cdx-list{list-style:none;margin:0;padding:0}
.cdx-row{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:2px 8px;align-items:center;min-height:36px;padding:6px 12px 6px 14px;border-bottom:1px solid var(--line1)}
.cdx-list>li:last-child>.cdx-row,.cdx-list>.cdx-row:last-child{border-bottom:0}
.cdx-list.plain .cdx-row{border-bottom:0;padding-top:7px;padding-bottom:7px}
.cdx-pinmark{display:inline-flex;color:var(--clay);flex:none}
.cdx-sizenum{min-width:38px;text-align:right;color:var(--ink2)}
.cdx-under{position:absolute;left:14px;right:12px;bottom:2px;width:auto;height:2px;box-shadow:none;background:transparent;opacity:.55}
.cdx-drop1{min-width:46px}
.cdx-when{font-size:11px;color:var(--ink3);line-height:18px}
.cdx-line{font-size:12.5px;line-height:18px;color:var(--ink2);overflow-wrap:anywhere}
.cdx-line.bad{color:var(--bad)}
.cdx-row:hover{background:var(--hov)}
.cdx-row.click{cursor:pointer}
.cdx-row:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.cdx-row[aria-selected=true],.cdx-row.ticked{background:var(--sel);box-shadow:inset 2px 0 0 var(--clay)}
.cdx-row.unread{box-shadow:inset 2px 0 0 var(--clay)}
.cdx-row.unread .cdx-title{font-weight:600;color:var(--ink)}
.cdx-row.muted .cdx-title{color:var(--ink2)}
.cdx-row.gone{opacity:.62}
.cdx-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.cdx-title{display:flex;align-items:center;gap:6px;min-width:0;color:var(--ink);font-size:13px;line-height:18px}
.cdx-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cdx-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
.cdx-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:16px;color:var(--ink3);white-space:nowrap;overflow:hidden}
.cdx-meta>span{overflow:hidden;text-overflow:ellipsis}
.cdx-dot{display:inline-block;width:7px;height:7px;flex:none}
.cdx-dot.live{background:var(--clay)}
.cdx-dot.idle{background:var(--ink3)}
.cdx-dot.ok{background:var(--ok)}.cdx-dot.bad{background:var(--bad)}.cdx-dot.warn{background:var(--warn)}
.cdx-dot.pulse{animation:cdx-pulse 1.4s ease-in-out infinite}
@keyframes cdx-pulse{50%{opacity:.35}}
.cdx-chip{display:inline-flex;align-items:center;gap:3px;flex:none;font-size:10.5px;line-height:15px;padding:0 5px;border:1px solid var(--line);color:var(--ink2);white-space:nowrap;font-weight:500}
.cdx-chip.clay{color:var(--clay);border-color:color-mix(in srgb,var(--clay) 60%,transparent)}
.cdx-chip.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 60%,transparent)}
.cdx-chip.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 60%,transparent)}
.cdx-chip.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 60%,transparent)}
.cdx-side{display:flex;align-items:center;gap:4px;justify-self:end}
.cdx-acts{display:flex;align-items:center;gap:0;opacity:0;transition:opacity 120ms var(--ease)}
.cdx-row:hover .cdx-acts,.cdx-row:focus-within .cdx-acts,.cdx-row.open .cdx-acts{opacity:1}
@media (hover:none){.cdx-acts{opacity:1}}
.cdx-size{display:flex;flex-direction:column;align-items:flex-end;gap:3px;width:52px}
.cdx-mini{display:block;width:44px;height:3px;background:var(--l2);box-shadow:inset 0 0 0 1px var(--line1)}
.cdx-mini>i{display:block;height:100%}
.cdx-check{display:inline-flex;align-items:center;justify-content:center;width:22px;height:24px;margin:-2px -4px;cursor:pointer}
.cdx input[type=checkbox]{-webkit-appearance:none;appearance:none;display:inline-grid;place-content:center;flex:none;margin:0;width:14px;height:14px;
  border:1px solid var(--ink3);background:transparent;cursor:pointer;transition:background-color 120ms var(--ease),border-color 120ms var(--ease)}
.cdx input[type=checkbox]::before{content:"";width:8px;height:8px;transform:scale(0);background:var(--on-clay);
  clip-path:polygon(14% 44%,0 65%,50% 100%,100% 16%,80% 0%,43% 62%)}
.cdx input[type=checkbox]:hover:not(:disabled){border-color:var(--ink)}
.cdx input[type=checkbox]:checked,.cdx input[type=checkbox]:indeterminate{background:var(--clay);border-color:var(--clay)}
.cdx input[type=checkbox]:checked::before{transform:scale(1)}
.cdx input[type=checkbox]:indeterminate::before{transform:scale(1);height:2px;clip-path:none}
.cdx input[type=checkbox]:disabled{cursor:not-allowed;opacity:.35;border-style:dotted}
.cdx input[type=checkbox]:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-detail{grid-column:2 / -1;padding:4px 0 4px;display:flex;flex-direction:column;gap:6px;cursor:default}
.cdx-pre{margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;background:var(--l2);border:1px solid var(--line1);padding:6px 8px;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
.cdx-pre.short{max-height:9.2em}
.cdx-pre.log{white-space:pre;max-height:260px}
.cdx-text{font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
.cdx-btnrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}

/* context section */
.cdx-tools{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:4px 10px 4px 12px;background:var(--l1);border-bottom:1px solid var(--line1);min-height:34px;flex-wrap:wrap}
.cdx-tools label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2);cursor:pointer}
.cdx-foot{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;background:var(--l3);border-top:1px solid var(--line);box-shadow:0 -6px 0 -5px rgba(0,0,0,.08)}
.cdx-foot .cdx-num{color:var(--ink)}
.cdx-more{display:flex;justify-content:center;padding:6px 12px 10px}

/* forms */
.cdx-in{font:inherit;font-size:12px;line-height:16px;padding:5px 8px;border:1px solid var(--line);background:var(--base);color:var(--ink);min-height:28px;width:100%;resize:vertical}
.cdx-in:focus{outline:2px solid var(--blue);outline-offset:-1px}
select.cdx-in{width:auto;padding-right:4px}
.cdx-in.s{min-height:24px;padding:2px 6px;font-size:11.5px}
.cdx-form{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-bottom:1px solid var(--line1);background:var(--l2)}
.cdx-field{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.cdx-field>span{font-size:11px;color:var(--ink2)}
.cdx-frow{display:flex;gap:8px;flex-wrap:wrap}
.cdx-radio{display:flex;flex-direction:column;gap:4px}
.cdx-radio label{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:var(--ink);cursor:pointer;line-height:1.4}
.cdx-radio input{accent-color:var(--clay);margin:2px 0 0}
.cdx-help{font-size:11px;color:var(--ink3);line-height:1.45}

/* states */
.cdx-empty{padding:12px 14px 14px;color:var(--ink2);font-size:12px;line-height:1.5}
.cdx-empty b{display:block;color:var(--ink);font-weight:600;font-size:12.5px;margin-bottom:2px}
.cdx-empty-act{margin-top:8px}
.cdx-note{margin:8px 12px;padding:8px 10px;border:1px solid var(--line);border-left-width:3px;background:var(--l2);font-size:12px;line-height:1.5}
.cdx-note.bad{border-left-color:var(--bad)}.cdx-note.warn{border-left-color:var(--warn)}.cdx-note.ok{border-left-color:var(--ok)}
.cdx-note .cdx-btnrow{margin-top:6px}
.cdx-skel{height:26px;margin:4px 12px;background:var(--l2);animation:cdx-skel 1.2s ease-in-out infinite}
@keyframes cdx-skel{50%{opacity:.45}}
.cdx-center{padding:24px 16px;color:var(--ink2);line-height:1.5}

/* versions and epochs */
.cdx-diff{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;padding:6px 8px;background:var(--l2);border:1px solid var(--line1);max-height:280px;overflow:auto}
.cdx-diff ins{text-decoration:underline;text-decoration-color:var(--ok);text-underline-offset:2px;background:color-mix(in srgb,var(--ok) 20%,transparent);color:var(--ink)}
.cdx-diff del{text-decoration:line-through;text-decoration-color:var(--bad);background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--ink2)}
.cdx-vlist{display:flex;flex-direction:column}
.cdx-vrow{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:26px;padding:2px 6px;font-size:12px;cursor:pointer;color:var(--ink2)}
.cdx-vrow:hover{background:var(--hov)}
.cdx-vrow[aria-pressed=true]{background:var(--sel);color:var(--ink);box-shadow:inset 2px 0 0 var(--clay)}
.cdx-vrow:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}

/* toasts */
.cdx-toasts{position:absolute;left:10px;right:10px;bottom:10px;z-index:20;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none}
.cdx-toast{pointer-events:auto;position:relative;display:flex;align-items:center;gap:8px;padding:8px 6px 10px 12px;background:var(--l3);color:var(--ink);
  border:1px solid var(--line);box-shadow:var(--pop);font-size:12.5px;line-height:1.45;animation:cdx-in 160ms var(--ease)}
.cdx-toast.bad{border-left:3px solid var(--bad)}
.cdx-toast .cdx-grow{overflow-wrap:anywhere}
.cdx-toast-bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--clay);transform-origin:left center;animation:cdx-shrink linear forwards}
.cdx-toast.paused .cdx-toast-bar{animation-play-state:paused}
@keyframes cdx-shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes cdx-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* star in the assistant message action row */
.cdx-star{display:inline-flex;align-items:center}
.cdx-star button{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;
  padding:6px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm,0)}
.cdx-star button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cdx-star button[aria-pressed=true]{color:var(--tz-accent,var(--dsw-alias-brand-primary,#c1553a))}
.cdx-star button:disabled{opacity:.4;cursor:default}
.cdx-star button:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}
.cdx-star-msg{font-size:12px;color:var(--dsw-alias-label-tertiary);padding-left:4px}

/* main chat: edited messages and ghosts (outside the .cdx root: tokens with fallbacks) */
.cdx-edited.user{display:flex;flex-direction:column}
.cdx-edited.user>.cdx-vmark{align-self:flex-end;margin:2px 0 0}
.cdx-vmark{position:relative;display:inline-flex;align-items:center;height:calc(28px + var(--dsh-content-font-delta,0px))}
.cdx-vchip{font:inherit;font-family:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;padding:1px 6px;margin:0 2px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;border-radius:var(--dsw-radius-sm,0)}
.cdx-vchip:hover,.cdx-vchip[aria-expanded=true]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--tz-accent,var(--dsw-alias-brand-primary,#c1553a))}
.cdx-vchip:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}
.cdx-vpop{position:absolute;z-index:60;bottom:calc(100% + 6px);left:0;width:min(380px,80vw);max-height:min(420px,60vh);overflow:auto;display:flex;flex-direction:column;
  padding:4px 0;text-align:left;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-3,#2a2523);
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));box-shadow:var(--tz-shadow-pop,0 8px 24px rgba(0,0,0,.25));border-radius:var(--dsw-radius-lg,0)}
.cdx-vmark.end .cdx-vpop{left:auto;right:0}
.cdx-vpop.down{bottom:auto;top:calc(100% + 6px)}
.cdx-vpop-row{display:flex;flex-direction:column;gap:3px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.cdx-vpop-row:last-of-type{border-bottom:0}
.cdx-vpop-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,inherit);font-size:11.5px}
.cdx-vpop-head b{font-family:var(--tz-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.cdx-vpop-head>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-vpop-cur{flex:none!important;color:var(--tz-accent,#c1553a)}
.cdx-vpop-btn,.cdx-vpop-link{font:inherit;font-size:11.5px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:inherit;cursor:pointer}
.cdx-vpop-btn:hover,.cdx-vpop-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.cdx-vpop-link{align-self:flex-start;margin:6px 12px 4px;border-color:transparent;color:var(--dsw-alias-link,var(--tz-accent-2,#5e9bd6));padding:1px 0}
.cdx-vpop-text{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,inherit);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.cdx-vpop-note{padding:6px 12px;color:var(--dsw-alias-label-secondary,inherit)}
.cdx-ghost{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:2px 0}
.cdx-ghost-meta{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit)}
.cdx-ghost-from{font-weight:600;color:var(--dsw-alias-label-secondary,inherit);max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-ghost-time{font-variant-numeric:tabular-nums}
.cdx-ghost-tag,.cdx-ghost-kind{font:inherit;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;line-height:16px;padding:0 6px;background:transparent;border:1px dashed currentColor;border-radius:var(--dsw-radius-sm,0)}
.cdx-ghost-tag{color:var(--tz-accent-2,#5e9bd6);cursor:pointer}
.cdx-ghost-tag:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.cdx-ghost-tag:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}
.cdx-ghost-kind{border-style:solid;color:var(--dsw-alias-state-success-primary,#4f9d69)}
.cdx-ghost-kind.alert{color:var(--dsw-alias-state-error-primary,#e0685a)}
.cdx-ghost-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .8),92%);padding:10px 16px;color:var(--dsw-alias-label-primary,inherit);
  font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;overflow-wrap:anywhere;
  border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:color-mix(in srgb,var(--dsw-specific-bubble,rgba(128,128,128,.08)) 55%,transparent);border-radius:var(--dsw-radius-xl,0)}

.cdx-rewound{display:flex;align-items:center;gap:10px;margin:6px 0;color:var(--dsw-alias-label-tertiary,inherit)}
.cdx-rewound-line{flex:1;height:0;border-top:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.35))}
.cdx-rewound-text{font:inherit;font-size:12px;line-height:18px;padding:0 4px;border:0;background:transparent;color:inherit;cursor:pointer;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-rewound-text:hover:not(:disabled){color:var(--dsw-alias-label-secondary,inherit)}
.cdx-rewound-text:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}

/* settings page section */
.cdx-set{${VARS};font-size:13px;line-height:1.45;color:var(--ink);max-width:760px}
.cdx-set .cdx-note{margin:0 0 14px}
.cdx-sgroup{margin:0 0 18px;border-top:1px solid var(--line)}
.cdx-sgroup>h4{margin:0;padding:10px 0 6px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.cdx-srow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line1)}
.cdx-srow .t{font-size:13px;color:var(--ink)}
.cdx-srow .d{font-size:11.5px;color:var(--ink3);margin-top:1px}
.cdx-srow .cdx-in{width:220px}
.cdx-srow .cdx-in.n{width:110px;text-align:right}
.cdx-switch{all:unset;box-sizing:border-box;position:relative;display:inline-block;width:34px;height:18px;border:1px solid var(--line);background:var(--l2);cursor:pointer;flex:none}
.cdx-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;background:var(--ink3);transition:transform 120ms var(--ease)}
.cdx-switch[aria-checked=true]{background:var(--clay);border-color:var(--clay)}
.cdx-switch[aria-checked=true]::after{transform:translateX(16px);background:var(--on-clay)}
.cdx-switch:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.cdx-card{border:1px solid var(--line1);padding:8px 10px;margin:8px 0;background:var(--l2)}
.cdx-sbar{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;padding:10px 0;z-index:5;background:var(--l1);border-top:1px solid var(--line)}

@media (prefers-reduced-motion:reduce){
  .cdx *,.cdx-set *{transition:none!important;animation:none!important}
  .cdx-indet::before{left:0;width:100%;opacity:.6}
}
`

export function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
