// Server-rendered recipient pages and the private, native source inspector.
import { renderModelPlan } from '../../public/model-preview.js';
import { CODE_SYNTAX_STYLE, highlightCodeLines } from '../../public/code-syntax.js';
import { renderSharedDrawing } from './shared-drawing.js';
import { recipientExcerptText, shareDownloadOptions } from './share-download.js';
import { shareConversions } from './share-conversion.js';
import { MARKDOWN_STYLE, isMarkdownPath, markdownBlockHtml, markdownInlineHtml } from './markdown.js';
import { isPresentationPath } from '../dependencies/presentation-extraction.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

function formatDate(value) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --accent:#007aff; --green:#248a3d; --red:#d70015;
    /* Cited cells and lines: green unless the Mac app passes the source folder's colour. */
    --cited:#34c759;
    --text:rgba(24,24,27,.96); --text2:rgba(60,60,67,.72); --text3:rgba(60,60,67,.5);
    --line:rgba(60,60,67,.16); --surface:rgba(255,255,255,.78); --paper:#fff; --canvas:#eef0f4;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  }
  @media(prefers-color-scheme:dark){:root{--accent:#0a84ff;--green:#32d74b;--red:#ff453a;--cited:#30d158;
    --text:rgba(255,255,255,.92);--text2:rgba(235,235,245,.66);--text3:rgba(235,235,245,.42);
    --line:rgba(255,255,255,.14);--surface:rgba(48,48,53,.72);--paper:#242427;--canvas:#171719}}
  *{box-sizing:border-box} body{margin:0;padding:46px 24px;background:var(--canvas);color:var(--text);
    font:13px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
    -webkit-font-smoothing:antialiased} main{max-width:720px;margin:0 auto}
  h1{margin:4px 0 0;color:var(--text);font-size:24px;line-height:1.2;letter-spacing:-.025em;overflow-wrap:anywhere}
  .frame{margin-top:20px;padding:20px 22px;border:1px solid var(--line);border-radius:16px;background:var(--paper);
    box-shadow:0 16px 46px rgba(24,28,38,.12),0 2px 8px rgba(24,28,38,.06)}
  dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px 15px;margin:0 0 18px}
  dt{color:var(--text3);font-size:11px}dd{margin:0;color:var(--text);overflow-wrap:anywhere}
  dd.value{color:var(--green);font-size:19px;font-weight:700}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
  a.action{display:inline-flex;min-height:32px;align-items:center;padding:0 11px;border:1px solid var(--line);border-radius:8px;
    background:var(--surface);color:var(--text);font-weight:500;text-decoration:none}
  a.action:hover{background:color-mix(in srgb,var(--text) 6%,var(--surface))}
  table{width:100%;margin-top:16px;border-collapse:separate;border-spacing:0;overflow:hidden;border:1px solid var(--line);
    border-radius:10px;font-size:11px}th,td{padding:7px 9px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
  th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}th{color:var(--text3);font-weight:650}
  td.cited{background:color-mix(in srgb,var(--cited) 2.5%,var(--paper));box-shadow:inset 0 0 0 .8px color-mix(in srgb,var(--cited) 65%,transparent);font-weight:500}:is(.inspector-preview,.shared-recipient .shared-context-table) .row-number.cited{color:var(--cited);background:color-mix(in srgb,var(--cited) 14%,var(--paper));font-weight:600}.inspector-preview thead th.cited{color:var(--cited);background:color-mix(in srgb,var(--cited) 14%,var(--paper));font-weight:600}:is(.inspector-preview,.shared-recipient .shared-context-table) td.on-path{background:color-mix(in srgb,var(--cited) 14%,var(--paper))}
  .notice{margin-top:20px;color:var(--text3);font-size:11px}.unavailable{color:var(--red)}
  .privacy-preview{display:flex;flex-wrap:wrap;gap:5px;margin-top:16px;padding:13px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
  .privacy-block{padding:3px 5px;border-radius:5px;background:var(--paper);font-size:11px}
  .redaction{display:inline-flex;width:80px;max-width:100%;height:1.1em;vertical-align:middle;border-radius:2px;user-select:none}
  .redaction.blank{background:#000}
  .redaction.blur{align-items:center;gap:4px;filter:blur(3px);color:var(--text);opacity:.85}
  .redaction.blur>span{display:block;flex:0 0 13px;height:.75em;background:currentColor;border-radius:1px}
  .redaction.blur>span:nth-child(2){flex-basis:21px;height:.9em}.redaction.blur>span:nth-child(3){flex-basis:8px}.redaction.blur>span:nth-child(4){flex-basis:18px;height:.85em}
  td.redacted-cell{background:rgba(120,120,128,.1)!important;box-shadow:none!important}
  .shared-context-table{max-width:100%;margin-top:16px;overflow:auto;border:1px solid var(--line);border-radius:10px}.shared-context-table table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0;overflow:visible}
  .shared-context-table th,.shared-context-table td,.full-document .document-table td{max-width:320px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top}
  .full-document{min-width:0;max-width:100%;margin-top:16px}.full-document h2{margin:18px 0 7px;font-size:13px;overflow-wrap:anywhere}.full-document .document-table{display:block;max-width:100%;max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px}.full-document .document-table table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0;overflow:visible}.full-document .document-table thead th{position:sticky;top:0;z-index:2;background:var(--surface);font-weight:600}.full-document .document-table tbody tr:first-child td{font-weight:600}.full-document.document-text{display:grid;min-width:0;gap:7px}.full-document .document-block{min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);line-height:1.5;overflow-wrap:anywhere}.full-document.document-lines{gap:2px}.full-document.document-lines .document-block{padding:3px 10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
  html:has(body.inspector-spatial){width:100%;height:100%;overflow:hidden}body.inspector-spatial{width:100%;height:100%;padding:0;overflow:hidden;background:transparent}.inspector-spatial main{width:100%;height:100%;max-width:none;min-width:0;overflow:hidden}
  .inspector-shell{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;width:100%;height:100%;min-width:0;overflow:hidden;color:var(--text);font-size:12px}
  .inspector-body{display:flex;min-width:0;min-height:0;flex-direction:column;padding:16px 16px 14px;gap:13px;overflow:hidden}
  .source-summary{display:flex;flex:0 0 auto;min-width:0;align-items:flex-start;justify-content:space-between;gap:12px}.source-summary strong{min-width:0;max-height:3.9em;overflow:auto;font-size:16px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
  .close-inspector{display:grid;width:23px;height:23px;flex:0 0 auto;place-items:center;border:0;border-radius:5px;background:transparent;color:var(--text2);cursor:default}.close-inspector svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.close-inspector:hover{background:color-mix(in srgb,var(--text) 8%,transparent)}
  .inspector-details{display:grid;flex:0 1 auto;grid-template-columns:minmax(0,1fr);gap:7px;min-width:0;min-height:0;max-height:36%;margin:0;padding:0;overflow:auto;overscroll-behavior:contain}.inspector-details>div{display:grid;min-width:0;grid-template-columns:58px minmax(0,1fr);gap:9px}.inspector-details dt{font-size:11px}.inspector-details dd{min-width:0;font-size:11px;overflow-wrap:anywhere}.inspector-details .file-location{user-select:all}
  .inspector-preview{display:flex;flex:1 1 120px;min-width:0;min-height:0;flex-direction:column;margin:0;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
  .preview-heading{display:flex;flex:0 0 auto;min-width:0;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--surface)}.preview-heading span{flex:0 0 auto;font-size:11px;font-weight:650}.preview-heading small{min-width:0;max-height:3em;overflow:auto;color:var(--text3);font-size:10px;overflow-wrap:anywhere}
  .preview-scroll{flex:1;min-width:0;min-height:0;width:100%;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.inspector-preview table{width:max-content;min-width:100%;margin:0;overflow:visible;border:0;border-radius:0;font-size:11px}.inspector-preview th,.inspector-preview td{height:27px;padding:5px 9px;white-space:pre}.inspector-preview thead th{position:sticky;top:0;z-index:2;text-align:center;background:var(--paper);color:var(--text3);font-size:10px;font-weight:500}.inspector-preview .row-number{position:sticky;left:0;z-index:1;min-width:31px;text-align:right;background:var(--paper);color:var(--text3);font-size:10px;font-weight:400;user-select:none}.inspector-preview thead .row-number{z-index:3}
  :is(.preview-scroll,.document-table,.shared-context-table)::-webkit-scrollbar{width:10px;height:10px}:is(.preview-scroll,.document-table,.shared-context-table)::-webkit-scrollbar-track,:is(.preview-scroll,.document-table,.shared-context-table)::-webkit-scrollbar-corner{background:var(--paper)}:is(.preview-scroll,.document-table,.shared-context-table)::-webkit-scrollbar-thumb{min-width:24px;min-height:24px;border:2px solid var(--paper);border-radius:8px;background:var(--text2)}:is(.preview-scroll,.document-table,.shared-context-table)::-webkit-scrollbar-thumb:hover{background:var(--text)}:is(.preview-scroll,.document-table,.shared-context-table):focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .source-markdown{padding:10px 14px;font-size:12px;line-height:1.55}
  .source-lines{display:table;min-width:100%;margin:0;padding:8px 0;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.source-line{display:table-row}.source-line.cited{background:color-mix(in srgb,var(--cited) 14%,var(--paper));box-shadow:inset 2.5px 0 0 var(--cited)}.line-number{display:table-cell;position:sticky;left:0;padding:0 10px;color:var(--text3);background:var(--paper);text-align:right;user-select:none}.line-content{display:table-cell;padding:0 10px;white-space:pre}.source-document-text{padding:16px;font:13px/1.7 Georgia,serif;white-space:pre-wrap;overflow-wrap:anywhere}.source-pdf{display:block;flex:1;width:100%;min-height:0;border:0;background:var(--paper)}.source-image{display:block;max-width:100%;height:auto;margin:auto}.source-video{display:block;flex:0 0 auto;width:100%;max-height:62%;background:#000}.source-transcript .line-content{white-space:pre-wrap}.preview-unavailable{padding:18px;color:var(--text2);font-size:12px;line-height:1.6}
  .slide-picture{display:grid;place-items:center;padding:10px;background:color-mix(in srgb,var(--text) 6%,var(--paper))}.cited-slide{position:relative;width:100%;max-height:100%;margin:0;border-radius:6px;overflow:hidden;background:color-mix(in srgb,var(--text) 10%,var(--paper));box-shadow:0 1px 3px rgba(0,0,0,.14)}.cited-slide img{position:relative;z-index:1;display:block;width:100%;height:100%;object-fit:contain}.cited-slide figcaption{position:absolute;inset:0;display:grid;place-items:center;color:var(--text2);font-size:12px}
  .inspector-spatial .preview-model{display:flex;flex-direction:column}.inspector-spatial .preview-model>.model-plan{display:flex;flex:1 0 auto;min-width:0;min-height:0;flex-direction:column}.inspector-spatial .preview-model .model-plan-head,.inspector-spatial .preview-model .model-plan-foot{flex:0 0 auto}.inspector-spatial .preview-model .model-plan-svg{flex:1 1 80px;height:80px;min-height:80px}.inspector-spatial .preview-image{display:flex}.inspector-spatial .preview-image .source-image{width:100%;height:100%;min-height:0;object-fit:contain}
  .inspector-toolbar{display:flex;min-width:0;min-height:48px;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 50%,transparent)}.inspector-toolbar button{display:flex;flex:0 0 auto;height:30px;align-items:center;gap:6px;padding:0 14px;border:0;border-radius:999px;background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--text);font:500 12px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:default;-webkit-user-select:none;user-select:none}.inspector-toolbar button:hover{background:color-mix(in srgb,var(--text) 13%,transparent)}.inspector-toolbar button:active{background:color-mix(in srgb,var(--text) 18%,transparent)}.inspector-toolbar button.primary{background:#fff;color:#1d1d1f;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.08)}.inspector-toolbar button.primary:hover{background:#f4f4f6}.inspector-toolbar button.primary:active{background:#e8e8ec}.inspector-toolbar button.primary svg{stroke:#1d1d1f}.inspector-toolbar button.destructive{color:var(--red)}.inspector-toolbar button.destructive svg{stroke:var(--red)}.inspector-toolbar button svg{width:12px;height:12px;fill:none;stroke:var(--text2);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.inspector-toolbar,.source-summary,.preview-heading,.inspector-details dt{-webkit-user-select:none;user-select:none}.inspector-toolbar kbd{padding:1px 4px;border:1px solid var(--line);border-radius:3px;color:var(--text3);font:10px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}.inspector-toolbar .destructive{margin-left:auto}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

`;

// Recipient styles are scoped so the native inspector keeps its own sizing and
// persistent toolbar. Both views use Lasso's system font, surfaces and blue selection.
const RECIPIENT_STYLE = `
  body.shared-recipient{--canvas:#ececef;--paper:#fff;--surface:#f1f1f4;--toolbar:#f8f8fa;
    --text:rgba(24,24,27,.94);--text2:rgba(60,60,67,.72);--text3:rgba(60,60,67,.62);--line:rgba(60,60,67,.16);
    min-width:0;min-height:100vh;padding:28px 24px 40px;background:var(--canvas);font-size:13px;line-height:1.5}
  @media(prefers-color-scheme:dark){body.shared-recipient{--canvas:#151517;--paper:#202023;--surface:#29292d;--toolbar:#27272a;
    --text:rgba(255,255,255,.92);--text2:rgba(235,235,245,.64);--text3:rgba(235,235,245,.56);--line:rgba(255,255,255,.095)}}
  .shared-unavailable{padding-top:24px}
  .shared-recipient main{max-width:1080px;min-width:0}.shared-window{min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--paper);box-shadow:0 12px 35px rgba(0,0,0,.07)}
  .shared-toolbar{display:flex;min-height:55px;align-items:center;justify-content:space-between;gap:16px;padding:10px 20px;border-bottom:1px solid var(--line);background:var(--toolbar)}
  .shared-brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:650;letter-spacing:-.01em}.shared-brand svg{width:21px;height:21px;color:var(--text2)}
  .shared-recipient :is(.shared-brand,.shared-toolbar-label,.shared-source-icon,.shared-scope,.action) svg{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.shared-toolbar-label{display:flex;align-items:center;gap:6px;color:var(--text2);font-size:11px}.shared-toolbar-label svg{width:13px;height:13px}
  .shared-source{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:20px;padding:24px 24px 20px}.shared-source-identity{display:grid;min-width:0;grid-template-columns:38px minmax(0,1fr);gap:12px;align-items:start}
  .shared-source-icon{display:grid;width:38px;height:42px;place-items:center;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text2)}.shared-source-icon svg{width:22px;height:25px}.shared-source-icon.file-type{border:0;background:none}.shared-source-icon.file-type svg{width:34px;height:40px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.2))}
  .shared-file-type{margin:0 0 4px;color:var(--text3);font-size:11px;font-weight:500}.shared-recipient h1{margin:0;color:var(--text);font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-.025em;overflow-wrap:anywhere}
  .shared-file-name{margin:5px 0 0;color:var(--text2);font-size:12px;overflow-wrap:anywhere}.shared-scope{display:inline-flex;max-width:100%;flex:0 0 auto;align-items:center;gap:5px;margin-top:1px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text2);font-size:11px;line-height:1.4}.shared-scope svg{width:13px;height:13px;flex:0 0 auto}
  .shared-content{min-width:0;padding:0 24px 24px}.shared-content-card{min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
  .shared-content-heading{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--surface)}.shared-content-heading h2{margin:0;font-size:12px;font-weight:600}.shared-content-heading p{min-width:0;margin:2px 0 0;color:var(--text2);font-size:11px;overflow-wrap:anywhere}.shared-content-heading small{flex:0 0 auto;color:var(--text3);font-size:10px}
  .shared-recipient .shared-context-table{max-height:560px;max-height:min(65vh,560px);min-height:0;max-width:100%;margin:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border:0;border-radius:0}
  .shared-recipient .shared-context-table table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0;font-size:12px}.shared-recipient .shared-context-table th,.shared-recipient .shared-context-table td{min-width:94px;max-width:300px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;line-height:1.45}
  .shared-recipient .shared-context-table thead th{position:sticky;top:0;z-index:2;background:var(--surface);color:var(--text2);font-size:11px;font-weight:600}.shared-recipient .shared-context-table .column-letter{display:block;margin-bottom:3px;color:var(--text3);font-size:10px;font-weight:500}.shared-recipient .shared-passage{color:var(--text2)}.shared-claim{margin:0 24px 18px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--text) 3%,var(--surface))}.shared-claim-label{margin:0 0 6px;color:var(--text3);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}.shared-claim blockquote{margin:0;color:var(--text);font-size:15px;line-height:1.55;font-weight:500}.shared-claim blockquote::before{content:"“"}.shared-claim blockquote::after{content:"”"}.shared-claim-check{display:flex;align-items:center;gap:6px;margin:10px 0 0;color:var(--text3);font-size:12px}.shared-claim-check.verified{color:var(--text2)}.shared-claim-check svg{flex:none;width:14px;height:14px;fill:none;stroke:var(--cited);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.shared-recipient mark.shared-cited{padding:1px 2px;border-radius:3px;background:color-mix(in srgb,var(--cited) 18%,transparent);box-shadow:inset 0 -1.5px 0 var(--cited);color:var(--text);font-weight:500}.shared-recipient .shared-context-table .selected-column{color:var(--cited);background:color-mix(in srgb,var(--cited) 14%,var(--surface))}
  .shared-recipient .shared-context-table .row-number{position:sticky;left:0;z-index:1;min-width:37px;width:37px;max-width:37px;padding:8px 9px;text-align:right;background:var(--paper);color:var(--text3);font-size:10px;font-weight:400;white-space:nowrap;user-select:none}.shared-recipient .shared-context-table thead .row-number{z-index:3;background:var(--surface)}
  .shared-recipient td.cited{background:color-mix(in srgb,var(--cited) 2.5%,var(--paper));box-shadow:inset 0 0 0 .8px color-mix(in srgb,var(--cited) 65%,transparent);font-weight:500}.shared-selection-key{display:flex;align-items:center;gap:6px;margin:0;padding:8px 12px;border-top:1px solid var(--line);color:var(--text3);font-size:10px}.shared-selection-key i{width:9px;height:9px;border:.8px solid color-mix(in srgb,var(--cited) 65%,transparent);border-radius:2px;background:color-mix(in srgb,var(--cited) 2.5%,var(--paper))}
  .shared-recipient .full-document{margin:0;padding:12px;min-width:0}.shared-recipient .full-document section+section{margin-top:16px}.shared-recipient .full-document h2{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--text2)}.shared-recipient .full-document .document-table{max-height:560px;margin:0;border-radius:6px}.shared-recipient .full-document table{font-size:12px}.shared-recipient .document-table th{min-width:94px;padding:7px 10px;font-size:10px}.shared-recipient .document-table .row-number{position:sticky;left:0;z-index:1;min-width:37px;max-width:37px;padding:8px;text-align:right;background:var(--paper);font-size:10px;font-weight:400}.shared-recipient .document-table thead .row-number{z-index:3;background:var(--surface)}.shared-recipient .full-document td{padding:8px 10px}.shared-recipient .full-document.document-text{gap:0;padding:18px 20px}.shared-recipient .full-document .document-block{padding:9px 0;border:0;background:transparent;line-height:1.65}.shared-recipient .full-document.document-lines .document-block{padding:1px 0;line-height:1.5}.shared-recipient .drawing-document{padding:0}.shared-recipient .drawing-document .model-plan{border:0;border-radius:0}.shared-recipient .drawing-document .model-plan-svg{height:min(65vh,580px);min-height:260px}
  .shared-recipient .full-document.markdown-document{padding:18px 22px;font-size:13.5px;line-height:1.65}.shared-quote .markdown-document{white-space:normal}.shared-quote .md-paragraph{margin:0}.md-redacted{padding:6px 0}.md-redacted .redaction{width:min(100%,260px)}
  .shared-quote{margin:0;padding:20px;color:var(--text);font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.shared-empty{margin:0;padding:20px;color:var(--text2);font-size:12px;line-height:1.6}
  .shared-pdf{display:block;width:100%;height:720px;height:min(75vh,900px);min-height:320px;border:0;background:var(--surface)}
  .shared-downloads{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:16px}.shared-downloads p{flex:1;min-width:150px;margin:0;color:var(--text2);font-size:11px}.shared-recipient .actions{gap:8px;margin:0}.shared-recipient a.action{gap:6px;min-height:32px;padding:6px 10px;border-radius:6px;background:var(--surface);font-size:11px;font-weight:550;line-height:1.4}.shared-downloads a.action small{font-size:10px;font-weight:500;opacity:.8}.shared-recipient a.action svg{width:14px;height:14px;flex:0 0 auto;color:var(--text2)}.shared-recipient a.action.primary{background:color-mix(in srgb,var(--text) 9%,var(--surface));color:var(--text);font-weight:650}.shared-recipient a.action.primary:hover{background:color-mix(in srgb,var(--text) 13%,var(--surface))}.shared-recipient a.action:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .shared-provenance{display:flex;min-width:0;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0;padding:12px 24px;border-top:1px solid var(--line);background:var(--toolbar);color:var(--text3);font-size:10px}.shared-provenance p{margin:0}.shared-recipient .notice{margin:14px 3px 0;color:var(--text3);font-size:11px;line-height:1.6}.shared-recipient .privacy-preview{margin:0;padding:20px;border:0;border-radius:0}
  @media(max-width:640px){body.shared-recipient{padding:12px 10px 24px}.shared-toolbar{padding:10px 14px}.shared-source{gap:12px;padding:19px 14px 16px;flex-direction:column}.shared-source-identity{grid-template-columns:32px minmax(0,1fr);gap:10px}.shared-source-icon{width:32px;height:37px}.shared-recipient h1{font-size:18px}.shared-scope{margin-left:42px}.shared-content{padding:0 14px 18px}.shared-content-heading{align-items:flex-start}.shared-content-heading small{max-width:90px;text-align:right}.shared-downloads{align-items:stretch}.shared-downloads p{flex-basis:100%}.shared-recipient .actions{width:100%;flex-wrap:wrap}.shared-recipient a.action{justify-content:center;flex:1 1 auto;min-height:36px}.shared-provenance{padding:12px 14px;gap:5px}.shared-recipient .shared-context-table{max-height:55vh}.shared-recipient .full-document.document-text{padding:12px 15px}}
  @media(prefers-reduced-motion:reduce){.shared-recipient *{scroll-behavior:auto!important}}
`;

function page(title, body, bodyClass = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}${MARKDOWN_STYLE}${CODE_SYNTAX_STYLE}${bodyClass === 'shared-recipient' ? RECIPIENT_STYLE : ''}</style></head>
<body class="${escapeHtml(bodyClass)}"><main>${body}</main></body></html>`;
}

/// Distinct wording per state, with no hint that other tokens exist.
/**
 * What a Mac browser sees at the server's own address. Lasso lives in the
 * menu bar there; the old browser workbench is kept only for the Windows app.
 */
export function renderMenuBarHome() {
  return page('Lasso', `
    <article class="shared-window"><header class="shared-toolbar"><div class="shared-brand">${icon('lasso')}<span>Lasso</span></div></header>
    <section class="shared-content shared-unavailable"><h1>Lasso runs from the menu bar</h1>
      <p>Suggestions appear while you type in any app. Open The Ranch from the menu bar, or press Shift-Command-R, to see your sources.</p></section></article>
  `, 'shared-recipient');
}

export function renderUnavailable(status) {
  const message = {
    REVOKED: 'This dependency link has been revoked.',
    EXPIRED: 'This dependency link has expired.',
    SOURCE_MISSING: 'The source for this dependency is no longer available.',
    SCOPE_RESTRICTED: 'This link does not permit downloading the original document.',
    EXCERPT_UNAVAILABLE: 'An excerpt could not be generated for this source.',
    CONVERSION_UNAVAILABLE: 'This link does not offer a download in that format.',
    CONVERSION_FAILED: 'The download could not be converted to that format. Try the original format instead.',
  }[status] ?? 'This dependency link is invalid or no longer available.';
  return page('Shared source unavailable · Lasso', `
    <article class="shared-window"><header class="shared-toolbar"><div class="shared-brand">${icon('lasso')}<span>Lasso</span></div><span class="shared-toolbar-label">Shared source</span></header>
    <section class="shared-content shared-unavailable"><h1>Source unavailable</h1><p class="unavailable">${escapeHtml(message)}</p></section></article>
  `, 'shared-recipient');
}

function shareScopeName(scope) {
  return {
    DOCUMENT: 'Entire document',
    INDEXED: 'Indexed part only',
    REDACTED: 'Complete document with redactions',
    MARKED: 'Copy of the document with markings',
  }[scope] ?? 'Indexed part only';
}

function findRedaction(redactions, kind, coordinates) {
  return redactions.find((entry) => entry.kind === kind
    && Object.entries(coordinates).every(([key, value]) => (
      key === 'sheet' ? (entry[key] ?? 0) === value : entry[key] === value
    )));
}

function maskedValue(value, redaction) {
  if (!redaction) return escapeHtml(value);
  const effect = redaction.effect === 'BLANK' ? 'blank' : 'blur';
  // Only synthetic shapes reach the recipient. Blurring original text in CSS
  // would leave the private value recoverable from the page source.
  const placeholder = effect === 'blank' ? '' : '<span aria-hidden="true"></span>'.repeat(4);
  return `<span class="redaction ${effect}" role="img" aria-label="Redacted">${placeholder}</span>`;
}

function renderFullDocument(document, redactions, requireRedacted = false) {
  if (document?.kind === 'model-plan') return renderSharedDrawing(document, { requireRedacted });
  if (document?.kind === 'pdf' && document.fileUrl && (!requireRedacted || document.safe === true && document.redacted === true)) {
    const page = Math.max(1, Number(document.page) || 1);
    return `<iframe class="shared-pdf" src="${escapeHtml(document.fileUrl)}#page=${page}&zoom=page-width" title="Shared PDF document"></iframe>`;
  }
  if (document?.kind === 'table' && document.sheets?.length) {
    return `<div class="full-document">${document.sheets.map((sheet, sheetIndex) => {
      const columnCount = sheet.rows.reduce((count, row) => Math.max(count, row.length), 1);
      return `<section><h2>${escapeHtml(sheet.name || `Sheet ${sheetIndex + 1}`)}</h2>
       <div class="document-table" tabindex="0" role="region" aria-label="${escapeHtml(sheet.name || 'Shared worksheet')}"><table><thead><tr><th class="row-number" aria-label="Row number"></th>${Array.from({ length: columnCount }, (_, index) => `<th scope="col">${columnLetter(index)}</th>`).join('')}</tr></thead><tbody>${sheet.rows.map((row, rowIndex) => (
         `<tr><th class="row-number" scope="row">${rowIndex + 1}</th>${Array.from({ length: columnCount }, (_, column) => {
           const mask = findRedaction(redactions, 'CELL', { sheet: sheetIndex, row: rowIndex, column });
           return `<td class="${mask ? 'redacted-cell' : ''}">${maskedValue(row[column] ?? '', mask)}</td>`;
         }).join('')}</tr>`)).join('')}</tbody></table></div></section>`
    }).join('')}</div>`;
  }
  if (document?.kind === 'text' && document.format === 'markdown' && document.styles?.length === document.blocks?.length) {
    // A masked section keeps only its position. Its type and wording are omitted.
    return `<div class="full-document markdown-document">${document.styles.map((style, index) => {
      const mask = findRedaction(redactions, 'BLOCK', { block: index });
      return mask ? `<div class="md-redacted">${maskedValue('', mask)}</div>`
        : markdownBlockHtml(style, { className: style.cited ? 'cited' : '' });
    }).join('')}</div>`;
  }
  if (document?.kind === 'text' && document.blocks?.length) {
    const lines = document.format === 'lines' ? ' document-lines' : '';
    return `<div class="full-document document-text${lines}">${document.blocks.map((block, index) => {
      const mask = findRedaction(redactions, 'BLOCK', { block: index });
      return `<div class="document-block">${maskedValue(block, mask)}</div>`;
    }).join('')}</div>`;
  }
  return '<div class="privacy-preview">A complete preview could not be rendered for this file type.</div>';
}

function icon(name) {
  // Use the same mark as the main website, with the toolbar's theme color.
  if (name === 'lasso') return '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><g stroke-width="2"><ellipse cx="15" cy="12" rx="11" ry="7.5" transform="rotate(-10 15 12)"/><path d="M19.5 18.6c1.6 3.2 4.6 4.6 7.6 9.4"/><circle cx="19.3" cy="18.4" r="2" fill="currentColor" stroke="none"/></g></svg>';
  const paths = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    document: '<path d="M6 3.5h8l4 4V21H6Z"/><path d="M14 3.5v4h4M9 12h6M9 16h6"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11M3 14h18"/>',
    drawing: '<path d="M4 20V4h16M8 20V8h12M8 14h7v6M15 8v6"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    link: '<path d="m9 15 6-6M8 11l-2 2a4 4 0 0 0 6 6l2-2M16 13l2-2a4 4 0 0 0-6-6l-2 2"/>',
    // Drawn to match the SF Symbols xmark, arrow.up.right and link.badge.minus.
    xmark: '<path d="M6 6l12 12M18 6 6 18"/>',
    open: '<path d="M8 16 17 7M9 7h8v8"/>',
    unlink: '<path d="M10 14l4-4M9 11l-2 2a4 4 0 0 0 5.66 5.66l2-2M15 13l2-2a4 4 0 0 0-5.66-5.66l-2 2M4 4l16 16"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.document}</svg>`;
}

function columnLetter(index) {
  let result = '';
  do { result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26) - 1; } while (index >= 0);
  return result;
}

// A source's type as The Ranch shows it: a white page with the type on a
// band in the type's colour. The Ranch draws Office files with macOS's own
// icons, which a page cannot show, so those take their app's colour here.
const FILE_TYPE_COLOURS = [
  ['#107C41', ['xlsx', 'xlsm', 'xls', 'numbers']], ['#188038', ['csv', 'tsv']],
  ['#185ABD', ['docx', 'doc', 'pages']], ['#C43E1C', ['pptx', 'ppt', 'key']], ['#D93025', ['pdf']],
  ['#8E8E93', ['txt', 'rtf', 'log']], ['#46566B', ['md', 'markdown']],
  ['#8E44AD', ['json', 'yaml', 'yml', 'xml', 'toml']],
  ['#5856D6', ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'swift', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
    'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'css', 'scss']],
  ['#E8710A', ['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'ply', '3mf', 'usd', 'usdz', 'f3d', 'sldprt', 'dxf', 'dwg', 'ifc']],
  ['#D6336C', ['png', 'jpg', 'jpeg', 'gif', 'heic', 'tif', 'tiff', 'webp', 'bmp', 'svg']],
  ['#5E5CE6', ['mp4', 'mov', 'm4v']],
];
const SHORT_TYPE_LABELS = { jpeg: 'JPG', markdown: 'MD', sldprt: 'SLD', tiff: 'TIF' };

/** @param {string} filename @returns {string} the type's page icon as SVG */
function fileTypeIcon(filename) {
  const name = String(filename ?? '');
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const colour = FILE_TYPE_COLOURS.find(([, extensions]) => extensions.includes(extension))?.[0] ?? '#8E8E93';
  const label = SHORT_TYPE_LABELS[extension] ?? (extension.toUpperCase().slice(0, 5) || 'FILE');
  const size = label.length >= 4 ? 7.5 : 9;
  return `<svg class="file-type-icon" viewBox="0 0 32 38" aria-hidden="true">`
    + `<path d="M5 1.5h15l9.5 9.5v22.5a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-29a3 3 0 0 1 3-3z" fill="#fff" stroke="rgba(0,0,0,.18)" stroke-width="1"/>`
    + `<path d="M20 1.5v6.5a3 3 0 0 0 3 3h6.5" fill="#dcdce0" stroke="rgba(0,0,0,.18)" stroke-width="1"/>`
    + `<rect x="0.5" y="19" width="31" height="12.5" rx="2" fill="${colour}" stroke="none"/>`
    + `<text x="16" y="28.6" text-anchor="middle" font-size="${size}" font-weight="800" fill="#fff" stroke="none"`
    + ` font-family="-apple-system,BlinkMacSystemFont,system-ui,sans-serif">${escapeHtml(label)}</text></svg>`;
}

/**
 * The one cited cell of a table, when a single cell is cited. Its row is
 * washed from the row number up to it and its column from the letter down
 * to it, as one path that stops at the cell. A whole row or column cited has
 * no single cell, so only its headers are marked.
 * @param {{ cells: { cited?: boolean }[] }[]} rows
 * @returns {(row: number, column: number) => boolean} whether a cell lies on the way in
 */
function wayIntoCitedCell(rows) {
  const cited = rows.flatMap((row, rowIndex) => row.cells.flatMap((cell, column) => (cell.cited ? [{ rowIndex, column }] : [])));
  if (cited.length !== 1) return () => false;
  const [cell] = cited;
  return (rowIndex, column) => (rowIndex === cell.rowIndex && column < cell.column)
    || (column === cell.column && rowIndex < cell.rowIndex);
}

const cellClass = (cell, onPath) => (cell.cited ? 'cited' : onPath ? 'on-path' : '');

/** Numbers and words compared as written, whatever their commas, currency or case. */
const comparable = (value) => String(value ?? '').toLowerCase().replace(/[\s,$€£¥]/g, '');

/**
 * The sentence the share backs, as the sender wrote it, and whether the
 * cited value is in it. The value comes from the pinned version, so the
 * check holds whatever happens to the file later. A redacted share shows no
 * sentence: it could repeat what was hidden.
 */
function citedInPanel(citedIn, source, share, redacted) {
  if (!citedIn || redacted) return '';
  const value = comparable(source.valueText);
  const matches = value.length > 0 && comparable(citedIn).includes(value);
  const pinned = `version ${escapeHtml(source.snapshotVersion)} of ${escapeHtml(source.filename)}, ${escapeHtml(formatDate(share.createdAt))}`;
  return `<section class="shared-claim" aria-label="Where this source is cited">
        <p class="shared-claim-label">Cited in</p>
        <blockquote>${escapeHtml(citedIn)}</blockquote>
        <p class="shared-claim-check${matches ? ' verified' : ''}">${matches ? `${icon('check')}<span>The cited value matches ${pinned}.</span>`
          : `<span>Cited from ${pinned}.</span>`}</p>
      </section>`;
}

/** A cited passage inside its paragraph, the passage marked where it is found. */
function sharedPassage(paragraph, cited) {
  const at = cited ? paragraph.indexOf(cited) : -1;
  const body = at < 0 ? escapeHtml(paragraph)
    : `${escapeHtml(paragraph.slice(0, at))}<mark class="shared-cited">${escapeHtml(cited)}</mark>${escapeHtml(paragraph.slice(at + cited.length))}`;
  return `<blockquote class="shared-quote shared-passage">${body}</blockquote>`;
}

function recipientTable(preview) {
  const selected = column => preview.rows.some(row => row.cells[column]?.cited);
  const onPath = wayIntoCitedCell(preview.rows);
  return `<div class="shared-context-table" tabindex="0" role="region" aria-label="Shared worksheet excerpt"><table>
    <thead><tr><th class="row-number" aria-label="Row number"></th>${preview.headers.map((header, index) =>
      `<th scope="col" class="${selected(index) ? 'selected-column' : ''}"><small class="column-letter">${escapeHtml(preview.columns?.[index] ?? columnLetter(index))}</small>${escapeHtml(header || `Column ${preview.columns?.[index] ?? columnLetter(index)}`)}</th>`).join('')}</tr></thead>
    <tbody>${preview.rows.map((row, index) => `<tr><th class="row-number${row.cells.some(cell => cell.cited) ? ' cited' : ''}" scope="row">${escapeHtml(row.rowNumber ?? index + 1)}</th>${row.cells.map((cell, column) =>
      `<td class="${cellClass(cell, onPath(index, column))}">${escapeHtml(cell.value)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>${preview.rows.some(row => row.cells.some(cell => cell.cited)) ? '<p class="shared-selection-key"><i aria-hidden="true"></i>Highlighted cells are the shared selection.</p>' : ''}`;
}

export function renderSharePage(resolved, token, preview, document = null) {
  const { source, share } = resolved;
  const scope = share.accessScope ?? 'DOCUMENT';
  const redacted = scope === 'REDACTED';
  const marked = scope === 'MARKED' && document?.kind === 'pdf' && document.safe === true;
  const pdfExcerpt = scope === 'INDEXED' && /\.pdf$/i.test(source.filename);
  const redactions = redacted ? share.redactions ?? [] : [];
  const title = (redacted || scope === 'MARKED' || pdfExcerpt ? source.filename : source.label) || source.filename || 'Shared source';
  const hasTable = !redacted && preview?.headers?.length && preview.rows?.length;
  const hasDocument = redacted || marked || (scope === 'DOCUMENT' && (['model-plan', 'pdf'].includes(document?.kind) || document?.format === 'markdown'))
    || (scope === 'INDEXED' && document?.kind === 'pdf' && document.safe === true)
    || (scope === 'INDEXED' && document?.kind === 'model-plan' && document.citedPart === true)
    || (scope === 'INDEXED' && document?.citedSlide === true);
  const table = /\.(?:xlsx?|csv|tsv)$/i.test(source.filename) || hasTable || document?.kind === 'table';
  const drawing = /\.(?:dxf|ifc)$/i.test(source.filename);
  const model = /\.(?:step|stp)$/i.test(source.filename);
  const deck = isPresentationPath(source.filename);
  const type = table ? 'Spreadsheet' : drawing ? 'Design drawing' : model ? 'CAD model' : deck ? 'Presentation' : 'Document';
  const excerpt = pdfExcerpt || scope === 'MARKED' ? '' : recipientExcerptText(source);
  const content = hasTable ? recipientTable(preview)
    : hasDocument ? renderFullDocument(document, redactions, redacted)
      : preview?.kind === 'passage' && scope === 'INDEXED' ? sharedPassage(preview.paragraph, excerpt)
      : scope === 'MARKED' ? '<p class="shared-empty">The marked copy couldn’t be prepared. Ask the sender for a new link.</p>'
      : excerpt ? isMarkdownPath(source.filename)
        ? `<blockquote class="shared-quote"><div class="markdown-document"><p class="md-paragraph">${markdownInlineHtml(excerpt)}</p></div></blockquote>`
        : `<blockquote class="shared-quote">${escapeHtml(excerpt)}</blockquote>`
        : '<p class="shared-empty">An inline excerpt is unavailable for this source. The sharing options below show what you can download.</p>';
  const heading = redacted ? 'Redacted document' : marked ? 'Marked-up copy' : deck && scope === 'INDEXED' ? 'Shared slide'
    : scope === 'INDEXED' ? 'Shared excerpt' : deck ? 'Slides' : 'Source preview';
  const location = !redacted && (document?.safe || document?.citedSlide) && document.location ? document.location
    : !redacted && scope !== 'MARKED' && source.location && source.location !== '—' ? source.location : '';
  const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  const stats = hasTable ? `${counted(preview.rows.length, 'row')} · ${counted(preview.headers.length, 'column')}`
    : redacted && document?.kind === 'table' ? `${document.sheets?.length ?? 0} worksheets`
      : drawing && document?.kind === 'model-plan' ? 'Plan view'
        : model && document?.kind === 'model-plan' ? escapeHtml(document.view ?? '')
          : deck && scope === 'DOCUMENT' && document?.styles ? `${document.styles.filter((style) => style.type === 'heading').length} slides` : '';
  const options = shareDownloadOptions(resolved, preview, document);
  const base = `/d/${encodeURIComponent(token)}`;
  const originalType = String(source.filename ?? '').match(/\.([a-z\d]{1,10})$/i)?.[1].toUpperCase() || 'File';
  // Each other format sits beside the download it is made from.
  const conversions = shareConversions(resolved, preview, document);
  const converted = (of) => conversions.filter((entry) => entry.of === of).map(({ format, label }) =>
    `<a class="action" href="${base}/${of === 'excerpt' ? 'excerpt' : 'download'}?as=${format.toLowerCase()}" download>${icon('download')}<span>${escapeHtml(label)}</span><small>${format}</small></a>`);
  const actions = [
    options ? `<a class="action primary" href="${base}/excerpt" download>${icon('download')}<span>${options.label}</span><small>${options.format}</small></a>` : '',
    ...(options ? converted('excerpt') : []),
    scope === 'DOCUMENT' ? `<a class="action${options ? '' : ' primary'}" href="${base}/download" download>${icon('download')}<span>Download original</span><small>${escapeHtml(originalType)}</small></a>` : '',
    ...converted('original'),
  ].filter(Boolean).join('');
  const downloadDetail = options?.format === 'ZIP' ? 'All worksheets are included as separate CSV files.'
    : redacted ? 'The downloaded copy includes these redactions.'
      : marked ? 'The downloaded copy includes these markings.'
      : options?.type === 'slide' ? 'Download this slide as a presentation of its own, or as a picture.'
        : options ? 'Download the excerpt shown above.' : scope === 'DOCUMENT' ? 'Download the complete source file.' : '';
  const scopeLabel = scope === 'INDEXED' ? (deck ? 'Cited slide only' : 'Cited part only') : redacted ? 'Redacted copy'
    : scope === 'MARKED' ? 'Marked-up copy' : 'Entire document';
  const notice = scope === 'DOCUMENT' ? 'This link includes the original document shared with you.'
    : scope === 'INDEXED' && deck ? 'Only this slide is shared. The rest of the presentation, its speaker notes and comments are not included.'
    : scope === 'INDEXED' ? 'Only the excerpt shown here is shared. The original document is not included.'
      : scope === 'MARKED' ? 'This is a copy of the document with markings drawn on it. The original file is not included.'
      : 'Marked content has been removed from this view and its downloads. The original document is not included.';

  return page(`${title} · Lasso`, `
    <article class="shared-window">
      <header class="shared-toolbar"><div class="shared-brand">${icon('lasso')}<span>Lasso</span></div><span class="shared-toolbar-label">${icon('link')}Shared source</span></header>
      <section class="shared-source">
        <div class="shared-source-identity"><span class="shared-source-icon file-type">${fileTypeIcon(source.filename)}</span>
          <div><p class="shared-file-type">${type}</p><h1>${escapeHtml(title)}</h1>${title !== source.filename ? `<p class="shared-file-name">${escapeHtml(source.filename)}</p>` : ''}</div></div>
        <span class="shared-scope" title="${escapeHtml(shareScopeName(scope))}">${icon('lock')}${scopeLabel}</span>
      </section>
      ${citedInPanel(share.context?.citedIn, source, share, redacted)}
      <section class="shared-content">
        <div class="shared-content-card"><header class="shared-content-heading"><div><h2>${heading}</h2>${location ? `<p>${escapeHtml(location)}</p>` : ''}</div>${stats ? `<small>${stats}</small>` : ''}</header>${content}</div>
        ${actions ? `<div class="shared-downloads"><p>${downloadDetail}</p><nav class="actions" aria-label="Download shared content">${actions}</nav></div>` : ''}
      </section>
      <footer class="shared-provenance"><p>Version ${escapeHtml(source.snapshotVersion)}</p><p>Shared ${escapeHtml(formatDate(share.createdAt))}</p></footer>
    </article>
    <p class="notice">${notice} This view stays at Version ${escapeHtml(source.snapshotVersion)}, even if the source changes later.</p>
  `, 'shared-recipient');
}

/**
 * The cited slide, whole, as the picture Lasso draws of it. `preview.slidesUrl`
 * is where slide n's picture is, n appended.
 */
function renderCitedSlide(preview) {
  const cited = preview.slideNumber ?? preview.openAt?.slide ?? 1;
  const { slides, aspect } = preview.deck;
  // A number the deck no longer has shows its first slide rather than a missing picture.
  const slide = slides.find((entry) => entry.number === cited) ?? slides[0];
  const label = `Slide ${slide.number} of ${slides.length}${slide.title ? ` · ${slide.title}` : ''}`;
  return `<div class="preview-scroll slide-picture"><figure class="cited-slide" style="aspect-ratio:${Number(aspect) || 16 / 9}"><figcaption>${
    escapeHtml(label)}</figcaption><img fetchpriority="high" src="${escapeHtml(`${preview.slidesUrl}${slide.number}${preview.slidesQuery ?? ''}`)}" alt="${
    escapeHtml(label)}"></figure></div>`;
}

/** The private source inspector uses original file content and local provenance. */
export function renderInspectorPanel(resolved, reference, preview, { shareable = true } = {}) {
  const { source } = resolved;
  const position = preview?.location || source.location;
  let content = '<div class="preview-unavailable">This file cannot be displayed inline. Open the source to view it in its original application.</div>';
  let previewLabel = 'Source preview';
  if (preview?.kind === 'model-plan') {
    previewLabel = 'Model preview';
    // The drawing zooms, pans and (for 3D models) rotates in the inspector.
    content = `<div class="preview-scroll preview-model">${renderModelPlan(preview)}</div>`;
  } else if (preview?.kind === 'model-unavailable') {
    previewLabel = 'Model preview';
    content = `<div class="preview-unavailable">${escapeHtml(preview.reason ?? 'No displayable geometry was found for this indexed element.')}</div>`;
  } else if (preview?.kind === 'table') {
    // The cited cell's column letter and row number are marked, and the way from them into the cell.
    const citedColumn = (index) => preview.rows.some((row) => row.cells[index]?.cited);
    const onPath = wayIntoCitedCell(preview.rows);
    content = `<div class="preview-scroll"><table aria-label="Source worksheet"><thead><tr><th class="row-number" aria-label="Row number"></th>${preview.columns.map((column, index) => `<th scope="col"${citedColumn(index) ? ' class="cited"' : ''}>${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${preview.rows.map((row, rowIndex) => `<tr><th class="row-number${row.cells.some((cell) => cell.cited) ? ' cited' : ''}" scope="row">${row.rowNumber}</th>${row.cells.map((cell, column) => ({ cell, column })).filter(({ cell }) => !cell.covered).map(({ cell, column }) => `<td class="${cellClass(cell, onPath(rowIndex, column))}" rowspan="${cell.rowSpan ?? 1}" colspan="${cell.colSpan ?? 1}">${escapeHtml(cell.value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else if (preview?.kind === 'video') {
    previewLabel = 'Video';
    // The player starts at the cited moment (#t=), and its transcript lines carry their times.
    content = `<video class="source-video" controls playsinline preload="auto" src="${escapeHtml(preview.fileUrl)}#t=${Number(preview.startTime) || 0}" data-start="${Number(preview.startTime) || 0}"></video>
      <div class="preview-scroll source-transcript"><div class="source-lines">${preview.lines.map((line) => `<div class="source-line ${line.cited ? 'cited' : ''}"><span class="line-number">${escapeHtml(line.timestamp)}</span><span class="line-content">${escapeHtml(line.text)}</span></div>`).join('')}</div></div>`;
  } else if (preview?.kind === 'pdf') {
    content = `<iframe class="source-pdf" src="${escapeHtml(preview.fileUrl)}#page=${preview.page}&zoom=page-width" title="${escapeHtml(source.filename)}"></iframe>`;
  } else if (preview?.kind === 'image') {
    content = `<div class="preview-scroll preview-image"><img class="source-image" src="${escapeHtml(preview.fileUrl)}" alt="${escapeHtml(source.filename)}"></div>`;
  } else if (preview?.kind === 'text' && preview.deck && preview.slidesUrl) {
    previewLabel = 'Slides';
    content = renderCitedSlide(preview);
  } else if (preview?.kind === 'text' && preview.format === 'markdown') {
    // Links are shown but not followed: the inspector is a local, private view.
    content = `<div class="preview-scroll"><div class="markdown-document source-markdown">${preview.blocks.map((block) =>
      markdownBlockHtml(block, { links: false, className: block.cited ? 'cited' : '' })).join('')}</div></div>`;
  } else if (preview?.kind === 'text') {
    previewLabel = preview.extracted ? 'Document text' : 'Source preview';
    // Code is coloured as The Ranch and the suggestion card colour it.
    const coloured = preview.extracted ? null : highlightCodeLines(preview.lines.map((line) => line.value), source.filename);
    content = preview.extracted
      ? `<div class="preview-scroll source-document-text">${escapeHtml(preview.lines.map((line) => line.value).join('\n'))}</div>`
      : `<div class="preview-scroll"><div class="source-lines">${preview.lines.map((line, index) => `<div class="source-line ${line.cited ? 'cited' : ''}"><span class="line-number">${line.lineNumber}</span><span class="line-content">${(coloured ? coloured[index] : escapeHtml(line.value)) || '&nbsp;'}</span></div>`).join('')}</div></div>`;
  }
  const localPayload = JSON.stringify({ referenceId: reference ?? null, absolutePath: source.absolutePath ?? null,
    openAt: preview?.openAt ?? null }).replace(/</g, '\\u003c');

  return page(`${source.label} · source`, `
    <section class="inspector-shell" aria-label="Source inspector">
      <div class="inspector-body">
        <div class="source-summary"><strong>${escapeHtml(source.label)}</strong><button class="close-inspector" data-action="close" aria-label="Close source inspector">${icon('xmark')}</button></div>
        <dl class="inspector-details">
          <div><dt>Source</dt><dd>${escapeHtml(source.filename)}</dd></div>
          <div><dt>Location</dt><dd class="file-location">${escapeHtml(source.absolutePath || resolved.internal?.filePath || 'Unavailable')}</dd></div>
          ${position && position !== '—' ? `<div><dt>Selection</dt><dd>${escapeHtml(position)}</dd></div>` : ''}
        </dl>
        <div class="inspector-preview"><div class="preview-heading"><span>${previewLabel}</span>${preview?.sheet ? `<small>${escapeHtml(preview.sheet)}</small>` : ''}</div>${content}</div>
      </div>
      <footer class="inspector-toolbar">
        <button data-action="open" class="primary">${icon('open')}Open Source</button>
        ${shareable ? '<button data-action="share">Share Link <kbd>Tab</kbd></button>' : ''}
        <button data-action="unlink" class="destructive">${icon('unlink')}Unlink</button>
      </footer>
    </section>
    <script>
      // The Mac app passes the source folder's colour, so the cited cell is marked as on the suggestion card.
      const sourceHighlight = new URLSearchParams(window.location.search).get('accent');
      if (/^#[0-9a-f]{6}$/i.test(sourceHighlight ?? '')) {
        document.documentElement.style.setProperty('--cited', sourceHighlight);
      }
      const sendAction = (action) => window.webkit?.messageHandlers?.inspector?.postMessage({ action, ...${localPayload} });
      document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        event.preventDefault();
        sendAction(button.dataset.action);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); sendAction('close'); }
        if (${shareable} && event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault(); sendAction('share');
        }
      });
      // A player that ignores the #t= fragment is moved to the cited moment once it can seek.
      const video = document.querySelector('video.source-video');
      video?.addEventListener('loadedmetadata', () => {
        const start = Number(video.dataset.start) || 0;
        if (Math.abs(video.currentTime - start) > 0.25) video.currentTime = start;
      }, { once: true });
      // Move only the source viewport. scrollIntoView can also scroll hidden
      // ancestor overflow and push the inspector's heading and actions away.
      requestAnimationFrame(() => {
        // The cited cell or passage itself, not the row number or column letter marked beside it.
        const selected = document.querySelector('.cited:not(th)');
        const viewport = selected?.closest('.preview-scroll');
        if (!viewport) return;
        const target = selected.getBoundingClientRect();
        const frame = viewport.getBoundingClientRect();
        const rowHeader = viewport.querySelector('.row-number')?.getBoundingClientRect().width ?? 0;
        const columnHeader = viewport.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        // Sideways it moves only as far as the cell needs, so the row's name stays in view where it can.
        const visibleLeft = frame.left + rowHeader;
        const visibleRight = frame.left + viewport.clientWidth;
        if (target.left < visibleLeft) viewport.scrollLeft += target.left - visibleLeft;
        else if (target.right > visibleRight) viewport.scrollLeft += Math.min(target.right - visibleRight, target.left - visibleLeft);
        viewport.scrollTop += target.top - frame.top - columnHeader
          - Math.max(0, (viewport.clientHeight - columnHeader - target.height) / 2);
      });
    </script>
    ${preview?.kind === 'model-plan' ? `<script type="module">import { bindModelPlans } from '/model-preview.js?v=3'; bindModelPlans(document);</script>` : ''}
  `, 'inspector inspector-spatial');
}
