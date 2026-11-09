// How recipient pages look: a macOS document on a quiet ground, with a glass
// toolbar, grey capsule controls and hairlines, as The Ranch draws its own.
// Scoped so the native inspector keeps its own sizing and toolbar.
export const RECIPIENT_STYLE = `
  body.shared-recipient{--canvas:#f5f5f7;--paper:#fff;--surface:#fafafb;--wash:rgba(0,0,0,.05);--wash-strong:rgba(0,0,0,.1);
    --text:rgba(0,0,0,.86);--text2:rgba(0,0,0,.62);--text3:rgba(0,0,0,.54);--line:rgba(0,0,0,.1);
    --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05);--gutter:24px;
    min-width:0;min-height:100vh;margin:0;padding:0;background:var(--canvas);font-size:13px;line-height:1.5}
  @media(prefers-color-scheme:dark){body.shared-recipient{--canvas:#1b1b1d;--paper:#242426;--surface:#2a2a2d;--wash:rgba(255,255,255,.07);--wash-strong:rgba(255,255,255,.14);
    --text:rgba(255,255,255,.88);--text2:rgba(255,255,255,.62);--text3:rgba(255,255,255,.5);--line:rgba(255,255,255,.1);
    --shadow:none}}
  .shared-recipient main{max-width:none;min-width:0;margin:0}
  .shared-recipient :is(.shared-brand,.shared-state-mark,.shared-facts,.action) svg{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}

  .shared-toolbar{position:sticky;top:0;z-index:10;display:flex;min-height:52px;align-items:center;justify-content:space-between;gap:16px;padding:8px var(--gutter);border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--canvas) 78%,transparent);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px)}
  .shared-brand{display:flex;flex:0 0 auto;align-items:center;gap:8px;font-size:14px;font-weight:600;letter-spacing:-.01em}
  .shared-brand svg{width:20px;height:20px}
  .shared-toolbar-label{margin-left:2px;padding-left:10px;border-left:1px solid var(--line);color:var(--text2);font-size:12px;font-weight:400;letter-spacing:0}
  .shared-recipient .actions{display:flex;min-width:0;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin:0}
  .shared-recipient a.action{gap:6px;min-height:30px;padding:0 12px;border:0;border-radius:999px;background:var(--wash);font-size:12px;font-weight:500;line-height:1;white-space:nowrap}
  .shared-recipient a.action:hover{background:var(--wash-strong)}
  .shared-recipient a.action svg{width:13px;height:13px;flex:0 0 auto;color:var(--text2)}
  .shared-recipient a.action small{color:var(--text3);font-size:10.5px;font-weight:500}
  .shared-recipient a.action.primary{background:var(--wash-strong);color:var(--text);font-weight:600}
  .shared-recipient a.action.primary:hover{background:color-mix(in srgb,var(--text) 18%,transparent)}
  .shared-recipient a.action:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  .shared-window{width:100%;max-width:920px;min-width:0;margin:0 auto;padding:36px var(--gutter) 48px}
  .shared-window[data-width="reading"]{max-width:760px}
  .shared-source{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:center}
  .shared-source-icon{display:block;line-height:0}
  .shared-source-icon svg{width:38px;height:45px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.2))}
  .shared-recipient h1{margin:0;color:var(--text);font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
  .shared-file-name{margin:3px 0 0;color:var(--text2);font-size:13px;overflow-wrap:anywhere}
  .shared-facts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 9px;margin:16px 0 0;padding:0;list-style:none;color:var(--text2);font-size:12px}
  .shared-facts li{display:inline-flex;align-items:center;gap:5px}
  .shared-facts li+li::before{content:"";width:3px;height:3px;margin-right:4px;border-radius:50%;background:var(--text3)}
  .shared-facts svg{width:13px;height:13px;flex:0 0 auto}

  .shared-claim{margin:20px 0 0;padding:14px 16px;border-radius:12px;background:var(--wash)}
  .shared-claim-label{margin:0 0 5px;color:var(--text2);font-size:11.5px;font-weight:600}
  .shared-claim blockquote{margin:0;color:var(--text);font-size:15px;line-height:1.5;font-weight:500;overflow-wrap:anywhere}
  .shared-claim blockquote::before{content:"“"}
  .shared-claim blockquote::after{content:"”"}
  .shared-claim-check{display:flex;align-items:flex-start;gap:6px;margin:8px 0 0;color:var(--text2);font-size:12px}
  .shared-claim-check svg{flex:none;width:14px;height:14px;margin-top:2px;fill:none;stroke:var(--cited);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

  .shared-content{min-width:0;margin-top:20px}
  .shared-content-card{min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--paper);box-shadow:var(--shadow)}
  .shared-content-heading{display:flex;min-width:0;min-height:40px;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;border-bottom:1px solid var(--line)}
  .shared-content-heading>div{display:flex;min-width:0;flex-wrap:wrap;align-items:baseline;gap:1px 8px}
  .shared-content-heading h2{margin:0;font-size:12.5px;font-weight:600}
  .shared-content-heading p{min-width:0;margin:0;color:var(--text2);font-size:12px;overflow-wrap:anywhere}
  .shared-content-heading small{flex:0 0 auto;color:var(--text3);font-size:11.5px;font-variant-numeric:tabular-nums}

  .shared-recipient .shared-context-table{max-height:560px;max-height:min(65vh,560px);min-height:0;max-width:100%;margin:0;overflow:auto;overscroll-behavior:contain;border:0;border-radius:0}
  .shared-recipient .shared-context-table table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0;font-size:12.5px;font-variant-numeric:tabular-nums}
  .shared-recipient .shared-context-table th,.shared-recipient .shared-context-table td{min-width:94px;max-width:300px;padding:8px 11px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;line-height:1.45}
  .shared-recipient .shared-context-table thead th{position:sticky;top:0;z-index:2;background:var(--surface);color:var(--text2);font-size:12px;font-weight:600}
  .shared-recipient .shared-context-table .column-letter{display:block;margin-bottom:2px;color:var(--text3);font-size:10.5px;font-weight:500}
  .shared-recipient .shared-context-table .selected-column{color:color-mix(in srgb,var(--cited) 62%,var(--text));background:color-mix(in srgb,var(--cited) 14%,var(--surface))}
  .shared-recipient .shared-context-table .row-number{position:sticky;left:0;z-index:1;min-width:37px;width:37px;max-width:37px;padding:8px 9px;text-align:right;background:var(--paper);color:var(--text3);font-size:10.5px;font-weight:400;white-space:nowrap;user-select:none}
  .shared-recipient .shared-context-table thead .row-number{z-index:3;background:var(--surface)}
  .shared-recipient .shared-context-table .row-number.cited{color:color-mix(in srgb,var(--cited) 62%,var(--text))}
  .shared-recipient td.cited{background:color-mix(in srgb,var(--cited) 2.5%,var(--paper));box-shadow:inset 0 0 0 .8px color-mix(in srgb,var(--cited) 65%,transparent);font-weight:500}
  .shared-selection-key{display:flex;align-items:center;gap:6px;margin:0;padding:8px 14px;border-top:1px solid var(--line);color:var(--text3);font-size:11.5px}
  .shared-selection-key i{width:9px;height:9px;border:.8px solid color-mix(in srgb,var(--cited) 65%,transparent);border-radius:2px;background:color-mix(in srgb,var(--cited) 2.5%,var(--paper))}

  .shared-recipient .full-document{margin:0;padding:14px;min-width:0}
  .shared-recipient .full-document section+section{margin-top:18px}
  .shared-recipient .full-document h2{margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--text2)}
  .shared-recipient .full-document .document-table{max-height:560px;margin:0;border-radius:8px}
  .shared-recipient .full-document table{font-size:12.5px;font-variant-numeric:tabular-nums}
  .shared-recipient .document-table th{min-width:94px;padding:7px 11px;font-size:10.5px}
  .shared-recipient .document-table .row-number{position:sticky;left:0;z-index:1;min-width:37px;max-width:37px;padding:8px;text-align:right;background:var(--paper);font-size:10.5px;font-weight:400}
  .shared-recipient .document-table thead .row-number{z-index:3;background:var(--surface)}
  .shared-recipient .full-document td{padding:8px 11px}
  .shared-recipient .full-document.document-text{gap:0;padding:20px 26px}
  .shared-recipient .full-document .document-block{padding:8px 0;border:0;background:transparent;font-size:14px;line-height:1.65}
  .shared-recipient .full-document.document-lines .document-block{padding:1px 0;font-size:12px;line-height:1.5}
  .shared-recipient .full-document.markdown-document{padding:24px 28px;font-size:14px;line-height:1.65}
  .shared-recipient .drawing-document{padding:0}
  .shared-recipient .drawing-document .model-plan{border:0;border-radius:0}
  .shared-recipient .drawing-document .model-plan-head{display:none}
  .shared-recipient .drawing-document .model-plan-svg{height:min(65vh,580px);min-height:260px}
  .shared-quote .markdown-document{white-space:normal}
  .shared-quote .md-paragraph{margin:0}
  .md-redacted{padding:6px 0}
  .md-redacted .redaction{width:min(100%,260px)}
  .shared-quote{margin:0;padding:22px 24px;color:var(--text);font-size:15px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
  .shared-recipient .shared-passage{color:var(--text2)}
  .shared-recipient mark.shared-cited{padding:1px 2px;border-radius:3px;background:color-mix(in srgb,var(--cited) 18%,transparent);box-shadow:inset 0 -1.5px 0 var(--cited);color:var(--text);font-weight:500}
  .shared-empty{margin:0;padding:32px 24px;color:var(--text2);font-size:13px;line-height:1.6;text-align:center}
  .shared-slide{margin:0;padding:16px;background:var(--surface)}
  .shared-slide img{display:block;width:100%;height:auto;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.14)}
  .shared-pdf{display:block;width:100%;height:720px;height:min(78vh,900px);min-height:320px;border:0;background:var(--surface)}
  .shared-recipient .privacy-preview{margin:0;padding:20px;border:0;border-radius:0}
  .shared-recipient :is(.document-table,.shared-context-table)::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--text) 28%,transparent);background-clip:padding-box}
  .shared-recipient :is(.document-table,.shared-context-table)::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--text) 46%,transparent);background-clip:padding-box}
  .shared-recipient .notice{max-width:68ch;margin:16px 2px 0;color:var(--text3);font-size:12px;line-height:1.55}

  .shared-state{display:grid;justify-items:center;gap:8px;max-width:420px;margin:0 auto;padding:clamp(56px,16vh,140px) var(--gutter) 48px;text-align:center}
  .shared-state-mark{display:grid;width:56px;height:56px;margin-bottom:8px;place-items:center;border-radius:16px;background:var(--wash);color:var(--text2)}
  .shared-state-mark svg{width:30px;height:30px}
  .shared-state h1{font-size:19px}
  .shared-state p{margin:0;color:var(--text2);font-size:13px;line-height:1.55}

  @media(max-width:640px){
    body.shared-recipient{--gutter:16px}
    .shared-toolbar{position:static;flex-wrap:wrap;gap:10px}
    .shared-recipient .actions{width:100%;justify-content:stretch}
    .shared-recipient a.action{flex:1 1 auto;min-height:36px;justify-content:center}
    .shared-window{padding-top:24px;padding-bottom:32px}
    .shared-recipient h1{font-size:19px}
    .shared-source-icon svg{width:32px;height:38px}
    .shared-content-heading{align-items:flex-start}
    .shared-recipient .shared-context-table{max-height:55vh}
    .shared-recipient .full-document.document-text,.shared-recipient .full-document.markdown-document,.shared-quote{padding:16px}
  }
  @media(prefers-reduced-motion:reduce){.shared-recipient *{scroll-behavior:auto!important}}
`;

/** The Lasso mark as a tab icon, in a grey that reads on a light or dark tab bar. */
export const RECIPIENT_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none' stroke='%236e6e73' stroke-width='2.4'%3E"
  + "%3Cellipse cx='15' cy='12' rx='11' ry='7.5' transform='rotate(-10 15 12)'/%3E%3Cpath d='M19.5 18.6c1.6 3.2 4.6 4.6 7.6 9.4'/%3E"
  + "%3Ccircle cx='19.3' cy='18.4' r='2' fill='%236e6e73' stroke='none'/%3E%3C/svg%3E";
