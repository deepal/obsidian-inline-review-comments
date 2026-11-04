import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const bundle = await build({ stdin: { contents: `
export * from './src/rendered-markers.ts'; export * from './src/marker-anchor.ts';
export * from './src/inline-avatar.ts'; export * from './src/hide-markers.ts';
export {EditorState} from '@codemirror/state'; export {editorInfoField,editorLivePreviewField} from 'obsidian';
`, resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false,
 plugins: [{ name: "host", setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
  b.onLoad({ filter: /.*/, namespace: "host" }, () => ({ resolveDir: process.cwd(), contents: `
import {StateField} from '@codemirror/state';
export const editorInfoField=StateField.define({create:()=>({}),update:v=>v});
export const editorLivePreviewField=StateField.define({create:()=>true,update:v=>v});
export class MarkdownRenderChild { constructor(el){this.containerEl=el;} }
export class Component {} export class Notice {} export class Scope {} export function setIcon() {}
` }));
 } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { RenderedMarkerManager, tableCellRanges, createInlineAvatar, createHideMarkersExtension, EditorState, editorInfoField, editorLivePreviewField } = api;

function fixture(text, html = "", { editor = false, lineStart = 0, lineEnd = text.split("\n").length - 1 } = {}) {
 const dom = new JSDOM(`<div class="markdown-reading-view"><div class="markdown-preview-view"><div id="root">${html}</div></div></div>`, { pretendToBeVisual: true });
 const win = dom.window, doc = win.document, frames = new Map(); let next = 0;
 Object.defineProperty(win.HTMLElement.prototype, "win", { get() { return this.ownerDocument.defaultView; } });
 // Model Obsidian's cross-window helper using the element's own constructor.
 win.Node.prototype.instanceOf = function (type) { return this instanceof this.ownerDocument.defaultView[type.name]; };
 globalThis.HTMLTableElement = win.HTMLTableElement;
 Object.defineProperty(win.Document.prototype, "win", { get() { return this.defaultView; } });
 win.createSpan=()=>doc.createElement("span");
 win.Node.prototype.createSpan=function(){const span=doc.createElement("span");this.appendChild(span);return span;};
 win.requestAnimationFrame = cb => { frames.set(++next, cb); return next; };
 win.cancelAnimationFrame = id => frames.delete(id);
 const plugin = { settings: { enabled: true, hideCommentMarkers: true } }, manager = new RenderedMarkerManager(plugin), root = doc.getElementById("root");
 const info = { text, lineStart, lineEnd }, children = [];
 const attach = (el = root) => { manager.handleBlock(el, { getSectionInfo: () => info, addChild: child => children.push(child) }); children.at(-1).onload(); };
 const flush = async () => {
  for (let limit = 0; limit < 12; limit++) {
   await new Promise(resolve => setImmediate(resolve));
   if (!frames.size) return;
   const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb());
  }
  assert.fail("marker redraws must settle");
 };
 const markers = () => [...root.querySelectorAll("[data-irc-rendered-marker]")];
 if (!editor) attach();
 return { dom, win, doc, root, plugin, manager, info, children, frames, attach, flush, markers,
  close() { manager.destroy(); dom.window.close(); } };
}
const label = el => el.getAttribute("aria-label");
const plain = el => { const copy=el.cloneNode(true);copy.querySelectorAll(".irc-inline-avatar").forEach(m=>m.remove());copy.normalize();return copy.innerHTML; };

const comment = (author = "Reviewer A") => `%% ${author ? `::${author}:: ` : ""}Review this cell. %%`;
const comparison = '<div class="inline-diff-proposal"><div>Earlier wording</div><div>Updated wording</div></div>';
const proposal = '{~~Earlier wording~>Updated wording~~}';
function wrappedTable(sourceCell, htmlCell, { header = false, wrapped = true } = {}) {
 const host = content => wrapped ? `<div class="table-cell-wrapper">${content}</div>` : content;
 const text = `| ${header ? sourceCell : "Item"} | Value |\n| --- | --- |\n| ${header ? "Previous" : sourceCell} | Stable |\n| Following sentinel. | Stable |`;
 const html = `<table><thead><tr><th>${host(header ? htmlCell : "Item")}</th><th>${host("Value")}</th></tr></thead><tbody><tr><td>${host(header ? "Previous" : htmlCell)}</td><td>${host("Stable")}</td></tr><tr><td>${host("Following sentinel.")}</td><td>${host("Stable")}</td></tr></tbody></table>`;
 return { text, html };
}

for (const header of [false, true]) for (const count of [1, 4]) for (const position of ["empty", "before", "after", "between"]) {
 test(`native wrapper contains ${count} fallback marker(s): ${header ? "header" : "body"}/${position}`, async () => {
  const comments = Array.from({ length: count }, (_, i) => comment(i % 2 ? null : `Reviewer ${i}`)).join(" ");
  const source = position === "empty" ? comments : position === "before" ? `${comments} ${proposal}` : position === "after" ? `${proposal}${comments}` : `${proposal}${comments} ${proposal}`;
  const html = position === "empty" ? "" : position === "between" ? comparison + comparison : comparison;
  const input = wrappedTable(source, html, { header }), f = fixture(input.text, input.html);
  const cell = f.root.querySelector(header ? "th" : "td"), wrapper = cell.firstElementChild, original = plain(f.root);
  const pair = cell.querySelector(".inline-diff-proposal"); let clicks = 0; pair?.addEventListener("click", () => clicks++);
  await f.flush();
  assert.equal(f.markers().length, count);
  assert.ok(f.markers().every(m => m.parentElement === wrapper));
  assert.ok(api.markerTargets(f.root, input.text, 0, 3).every(t => t.container === wrapper));
  assert.ok(api.markerTargets(f.root, input.text, 0, 3).every(t => api.markerPoint(t, input.text) === null));
  assert.equal(plain(f.root), original);
  if (pair) { assert.equal(cell.querySelector(".inline-diff-proposal"), pair); pair.click(); assert.equal(clicks, 1); assert.equal(f.markers()[0].previousElementSibling?.className, "inline-diff-proposal"); }
  for (let i = 0; i < 3; i++) { f.manager.refresh(); await f.flush(); assert.equal(f.markers().length, count); assert.ok(f.markers().every(m => m.parentElement === wrapper)); }
  f.close();
 });
}

for (const foreignWindow of [false, true]) test(`wrapped precise placement preserves links/code and owning document (${foreignWindow ? "foreign" : "main"} window)`, async () => {
 const input = wrappedTable('Text [label](url) `a|b` ' + comment() + ' tail', 'Text <a href="url">label</a> <code>a|b</code>  tail');
 const f = fixture(input.text, input.html), other = new JSDOM("");
 if (foreignWindow) globalThis.HTMLTableElement = other.window.HTMLTableElement;
 const wrapper = f.root.querySelector("td > .table-cell-wrapper"), link = wrapper.querySelector("a"), code = wrapper.querySelector("code"), original = plain(f.root);
 await f.flush();
 const [marker] = f.markers(), [target] = api.markerTargets(f.root, input.text, 0, 3);
 assert.equal(target.container, wrapper); assert.ok(api.markerPoint(target, input.text));
 assert.equal(marker.parentElement, wrapper); assert.equal(marker.ownerDocument, f.doc); assert.equal(marker.nextSibling.textContent, "tail");
 assert.equal(wrapper.querySelector("a"), link); assert.equal(wrapper.querySelector("code"), code); assert.equal(plain(f.root), original);
 f.close(); other.window.close();
});

test("only the direct cell wrapper is selected; nested wrappers and wrapper-free tables retain ownership", async () => {
 for (const wrapped of [false, true]) {
  const input = wrappedTable(comment(), '<div><table><tr><td><div class="table-cell-wrapper">Foreign nested content</div></td></tr></table></div>', { wrapped });
  const f = fixture(input.text, input.html); await f.flush();
  const cell = f.root.querySelector("td"), expected = wrapped ? cell.firstElementChild : cell;
  assert.equal(f.markers()[0].parentElement, expected); assert.equal(api.markerTargets(f.root, input.text, 0, 3)[0].container, expected); f.close();
 }
});

test("fallback markers and embedded editors use the native wrapper's owning window", async () => {
 const input = wrappedTable(proposal + commentsForWindow(), comparison);
 function commentsForWindow() { return comment("Window A") + ' ' + comment("Window B"); }
 const f = fixture(input.text, `<div class="cm-editor"><div class="cm-content"><div class="cm-table-widget">${input.html}</div></div></div>`, { editor: true }), other = new JSDOM("");
 globalThis.HTMLTableElement = other.window.HTMLTableElement;
 const dom = f.root.firstChild, contentDOM = dom.querySelector('.cm-content'), info = { editor: {} };
 const view = { dom, contentDOM, state: EditorState.create({ doc: input.text, extensions: [editorInfoField.init(() => info)] }), lineBlockAt() { return { from: 0, to: this.state.doc.length }; }, posAtDOM() { return 0; } }; info.editor.cm = view;
 const extension = f.manager.editorExtension().create(view); await f.flush();
 const cell = contentDOM.querySelector('td'), wrapper = cell.firstElementChild;
 assert.equal(f.markers().length, 2); assert.ok(f.markers().every(m => m.parentElement === wrapper && m.ownerDocument === f.doc));
 wrapper.innerHTML = '<div class="cm-editor"><div class="cm-content">Editing</div></div>'; await f.flush(); assert.equal(f.markers().length, 0);
 wrapper.innerHTML = comparison; await f.flush(); assert.equal(f.markers().length, 2); assert.ok(f.markers().every(m => m.parentElement === wrapper));
 extension.destroy(); await f.flush(); assert.equal(f.markers().length, 0); assert.equal(f.frames.size, 0); f.close(); other.window.close();
});

test("wrapped repeated cells and multiple tables keep source identity and order", async () => {
 const a = wrappedTable('Same \\| `a|b` ' + comment("First"), 'Same | <code>a|b</code>');
 const b = wrappedTable('Same \\| `a|b` ' + comment("Second"), 'Same | <code>a|b</code>');
 const f = fixture(a.text + '\n\n' + b.text, a.html + '<blockquote>' + b.html + '</blockquote>'); await f.flush();
 assert.deepEqual(f.markers().map(label), ["Comment by First", "Comment by Second"]);
 for (const [i, marker] of f.markers().entries()) { assert.equal(marker.closest("table"), f.root.querySelectorAll("table")[i]); assert.equal(marker.closest("tr").rowIndex, 1); assert.equal(marker.closest("td").cellIndex, 0); assert.ok(marker.closest('.table-cell-wrapper')); }
 f.close();
});

test("wrapped host replacement, comment updates and unload settle without stale markers", async () => {
 const input = wrappedTable(proposal + comment(), comparison), f = fixture(input.text, input.html); await f.flush();
 const cell = f.root.querySelector("td"), old = cell.firstElementChild, replacement = old.cloneNode(true);
 replacement.querySelectorAll('.irc-inline-avatar').forEach(m => m.remove()); old.replaceWith(replacement); await f.flush();
 assert.equal(f.markers().length, 1); assert.equal(f.markers()[0].parentElement, replacement); assert.equal(old.querySelectorAll('.irc-inline-avatar').length, 0);
 f.info.text = input.text.replace(comment(), comment("Reviewer B") + ' ' + comment(null)); f.manager.refresh(); await f.flush();
 assert.deepEqual(f.markers().map(label), ["Comment by Reviewer B", "Comment"]);
 f.plugin.settings.enabled = false; f.manager.refresh(); await f.flush(); assert.equal(f.markers().length, 0);
 f.plugin.settings.enabled = true; f.manager.refresh(); await f.flush(); assert.equal(f.markers().length, 2);
 f.info.text = input.text.replace(comment(), ''); f.manager.refresh(); await f.flush(); assert.equal(f.markers().length, 0);
 f.info.text = input.text; f.manager.refresh(); await f.flush(); assert.equal(f.markers().length, 1);
 f.children[0].onunload(); await f.flush(); assert.equal(f.markers().length, 0); assert.equal(f.frames.size, 0); f.close();
});

test("Reading view places compact author markers at their original positions without replacing existing DOM", async () => {
 const f=fixture("Before %% ::Jane Doe:: Review %% after.","<p>Before  after.</p>");
 const p=f.root.firstChild, original=plain(f.root); let clicks=0;p.addEventListener("click",()=>clicks++);
 await f.flush();const [marker]=f.markers();assert.equal(label(marker),"Comment by Jane Doe");assert.equal(marker.title,label(marker));assert.equal(marker.textContent,"JD");
 assert.equal(marker.parentNode,p);assert.equal(marker.previousSibling.textContent,"Before  ");assert.equal(marker.nextSibling.textContent,"after.");
 assert.equal(plain(f.root),original);p.click();assert.equal(clicks,1);assert.equal(f.root.firstChild,p);
 for(let i=0;i<5;i++){f.manager.refresh();await f.flush();assert.equal(f.markers().length,1);}
 assert.equal(plain(f.root),original);f.close();
});

test("formatted text, links, aliases, entities, escapes and inline code retain exact marker placement", async()=>{
 const text="One **bold** [label](https://example.com) &amp; \\_literal\\_ `code` %% ::A:: review %% [[File|alias]].";
 const f=fixture(text,'<p>One <strong>bold</strong> <a href="https://example.com">label</a> &amp; _literal_ <code>code</code>  <a class="internal-link">alias</a>.</p>');
 const link=f.root.querySelector("a"),original=plain(f.root);await f.flush();const [marker]=f.markers();
 assert.equal(marker.nextElementSibling.textContent,"alias");assert.ok(marker.previousSibling.textContent.trim()==="");assert.equal(f.root.querySelector("a"),link);assert.equal(plain(f.root),original);f.close();
});

test("markers next to links do not become part of their click targets",async()=>{
 const f=fixture("[label](url)%% ::A:: comment %%",'<p><a href="url">label</a></p>');await f.flush();
 assert.equal(f.markers()[0].parentNode.tagName,"P");assert.equal(f.root.querySelector("a").nextSibling,f.markers()[0]);f.close();
});

test("each adjacent comment has one marker in source order, including anonymous replies",async()=>{
 const f=fixture("word %% ::Alice:: one %% %% anonymous %% %% ::Bob:: two %% tail", "<p>word    tail</p>");await f.flush();
 assert.deepEqual(f.markers().map(label),["Comment by Alice","Comment","Comment by Bob"]);assert.ok(f.markers()[1].classList.contains("irc-inline-avatar-anon"));
 assert.equal(f.markers().at(-1).nextSibling.textContent,"tail");f.close();
});

test("table source columns respect escaped pipes, code spans, optional edge pipes and quoted tables",()=>{
 for(const line of ["| Left \\| value | `a|b` tail |","> | Left \\| value | `a|b` tail |","Left \\| value | `a|b` tail"]){
  const cells=tableCellRanges(line);assert.equal(cells.length,2);assert.match(line.slice(cells[0].from,cells[0].to),/Left \\\| value/);assert.match(line.slice(cells[1].from,cells[1].to),/`a\|b` tail/);
 }
});

test("table header/body markers stay in their correct cell across multiple tables",async()=>{
 const text="| Head %% ::H:: header %% | Other |\n| --- | --- |\n| Left \\| bar | `a|b` %% ::B:: body %% tail |\n\n| Next | Last |\n| --- | --- |\n| Value %% anonymous %% | End |";
 const table='<table><thead><tr><th>Head </th><th>Other</th></tr></thead><tbody><tr><td>Left | bar</td><td><code>a|b</code>  tail</td></tr></tbody></table>';
 const f=fixture(text,table+'<table><tr><th>Next</th><th>Last</th></tr><tr><td>Value </td><td>End</td></tr></table>');await f.flush();
 const markers=f.markers();assert.equal(markers.length,3);assert.deepEqual(markers.map(m=>m.parentElement.tagName),["TH","TD","TD"]);assert.match(markers[1].nextSibling.textContent,/tail/);assert.equal(markers[2].closest("table"),f.root.lastChild);f.close();
});

for(const [name,text,html,selector] of [
 ["heading","# Heading %% ::A:: c %% end","<h1>Heading  end</h1>","h1"],
 ["list items","- One %% ::A:: c %% end\n- Two %% ::B:: c %% end",'<ul><li data-line="0">One  end</li><li data-line="1">Two  end</li></ul>',"li"],
 ["blockquote","> Quote %% ::A:: c %% end","<blockquote><p>Quote  end</p></blockquote>","p"],
 ["callout","> [!note] Title\n>\n> Body %% ::A:: c %% end",'<div class="callout"><div class="callout-title"><div class="callout-icon">icon</div><div class="callout-title-inner">Title</div></div><div class="callout-content"><p>Body  end</p></div></div>',"p"],

]) test(`Reading view supports ${name}`,async()=>{
 const f=fixture(text,html);await f.flush();assert.ok(f.markers().length);for(const marker of f.markers())assert.equal(marker.parentElement.tagName.toLowerCase(),selector);f.close();
});

test("repeated words use their source position; ambiguous blocks fall back without guessing a sibling",async()=>{
 const f=fixture("same same %% ::A:: c %% same", "<p>same same  same</p>");await f.flush();assert.equal(f.markers()[0].previousSibling.textContent,"same same  ");f.close();
 const ambiguous=fixture("same %% ::A:: c %%", "<p>same</p><p>same</p>");await ambiguous.flush();assert.equal(ambiguous.markers()[0].parentElement,ambiguous.root);ambiguous.close();
});

test("standalone, multiline and comment-only sections stay visible",async()=>{
 for(const text of ["%% ::A:: only %%","%% ::A:: line\n\nsecond line %%","%% anonymous %% %% ::B:: reply %%"]){
  const f=fixture(text);await f.flush();assert.equal(f.markers().length,text.includes("reply")?2:1);assert.ok(f.root.classList.contains("irc-rendered-comment-block"));f.close();
 }
});

test("code literals are excluded and margin-card content is never postprocessed",async()=>{
 const f=fixture("`%% literal %%` %% ::A:: real %%\n\n```\n%% fenced %%\n```", "<p><code>%% literal %%</code> </p><pre><code>%% fenced %%</code></pre>");await f.flush();assert.equal(f.markers().length,1);f.close();
 const excluded=fixture("%% ::A:: c %%","<div class=\"irc-margin-layer\"><div id=\"card\">body</div></div>",{editor:true});excluded.attach(excluded.doc.getElementById("card"));await excluded.flush();assert.equal(excluded.markers().length,0);excluded.close();
});

test("current source, host redraws, settings and unload reconcile markers and release observers",async()=>{
 const f=fixture("Text %% ::A:: old %% tail","<p>Text  tail</p>");await f.flush();
 f.info.text="Text %% ::B:: new %% tail";f.root.firstChild.textContent="Text  tail";await f.flush();assert.equal(label(f.markers()[0]),"Comment by B");
 f.plugin.settings.enabled=false;f.manager.refresh();await f.flush();assert.equal(f.markers().length,0);
 f.plugin.settings.enabled=true;f.manager.refresh();await f.flush();assert.equal(f.markers().length,1);
 f.info.text="Text tail";f.root.firstChild.textContent="Text tail";await f.flush();assert.equal(f.markers().length,0);
 f.info.text="Text %% ::A:: c %% tail";f.root.firstChild.textContent="Text  tail";await f.flush();assert.equal(f.markers().length,1);
 f.children[0].onunload();assert.equal(f.markers().length,0);f.root.firstChild.textContent="Changed";await f.flush();assert.equal(f.frames.size,0);f.close();
});

test("detached blocks attach on their render frame; unload cancels pending work",async()=>{
 const f=fixture("%% ::A:: c %%");const parent=f.root.parentNode;f.root.remove();parent.appendChild(f.root);await f.flush();assert.equal(f.markers().length,1);f.close();
 const cancelled=fixture("%% ::A:: c %%");cancelled.children[0].onunload();await cancelled.flush();assert.equal(cancelled.markers().length,0);cancelled.close();
});

test("Reading sections loaded before virtualized DOM reattachment regain markers",async()=>{
 const f=fixture("Text %% ::A:: review %% tail","<p>Text  tail</p>");await f.flush();
 const preview=f.root.parentElement;
 f.children[0].onunload();f.root.remove();f.attach();await f.flush();assert.equal(f.markers().length,0);
 preview.appendChild(f.root);await f.flush();assert.equal(f.markers().length,1);
 f.children.at(-1).onunload();f.root.remove();await f.flush();preview.appendChild(f.root);await f.flush();assert.equal(f.markers().length,1,"cached DOM can return without another child onload");
 for(let i=0;i<3;i++){const child=f.children.at(-1);child.onunload();f.root.remove();f.attach();await f.flush();preview.appendChild(f.root);await f.flush();assert.equal(f.markers().length,1);}
 f.children.at(-1).onunload();await f.flush();assert.equal(f.markers().length,0);f.close();
});

test("embedded cell editors exclusively own active markers and inactive cells regain them without duplicates",async()=>{
 const text="| H | Other |\n| --- | --- |\n| Text %% ::A:: c %% tail | End |";
 const f=fixture(text,'<div class="cm-editor"><div class="cm-content"><div class="cm-table-widget"><table><tr><th>H</th><th>Other</th></tr><tr><td>Text  tail</td><td>End</td></tr></table></div></div></div>',{editor:true});
 const dom=f.root.firstChild,contentDOM=dom.querySelector(".cm-content"),info={editor:{}};
 const view={dom,contentDOM,state:EditorState.create({doc:text,extensions:[editorInfoField.init(()=>info)]}),lineBlockAt(){return {from:0,to:this.state.doc.length};},posAtDOM(){return 0;}};info.editor.cm=view;
 const extension=f.manager.editorExtension().create(view);await f.flush();assert.equal(f.markers().length,1);
 const cell=contentDOM.querySelector("td");
 for(let i=0;i<3;i++){
  cell.innerHTML='<div class="cm-editor"><div class="cm-content">Text</div></div>';const avatar=createInlineAvatar(f.doc,"A");cell.querySelector(".cm-content").appendChild(avatar);await f.flush();
  assert.equal(f.markers().length,0);assert.equal(cell.querySelectorAll(".irc-inline-avatar").length,1);
  cell.textContent="Text  tail";await f.flush();assert.equal(f.markers().length,1);
 }
 const old=contentDOM.querySelector("table"),replacement=old.cloneNode(true);replacement.querySelectorAll(".irc-inline-avatar").forEach(m=>m.remove());old.replaceWith(replacement);await f.flush();assert.equal(f.markers().length,1);
 extension.destroy();assert.equal(f.markers().length,0);f.close();
});

test("shared widgets use the owning document, keep reveal-on-cursor behavior, and shrink only inline avatars",async()=>{
 const f=fixture("", "",{editor:true}),field=createHideMarkersExtension(f.plugin),source="word %% ::Jane Doe:: comment %% end";
 let state=EditorState.create({doc:source,extensions:[editorLivePreviewField,field]});let widget;
 state.field(field).between(0,source.length,(from,to,value)=>{assert.ok(to>from);widget=value.spec.widget;});
 const marker=widget.toDOM({dom:f.root});assert.equal(marker.ownerDocument,f.doc);assert.equal(marker.textContent,"JD");
 state=state.update({selection:{anchor:source.indexOf("comment")}}).state;state.field(field).between(0,source.length,(from,to)=>assert.equal(from,to));
 const css=await readFile("styles.css","utf8");assert.match(css,/\.irc-inline-avatar \{[^}]*width: 1em;[^}]*height: 1em;/);assert.match(css,/\.irc-inline-avatar-anon \{[^}]*width: 0\.45em;/);f.close();
});


test("relocated footnotes use negative data-line offsets and never leave a duplicate at the source placeholder",async()=>{
 const text="Reference[^one].\n\n[^one]: Definition %% ::A:: c %% end\n\nTail.";
 const f=fixture(text,'<section class="footnotes"><ol><li data-line="-2"><p>Definition  end<a class="footnote-backref">↩</a></p></li></ol></section>',{lineStart:4,lineEnd:4});
 await f.flush();assert.equal(f.markers().length,1);assert.equal(f.markers()[0].parentElement.tagName,"P");assert.equal(f.markers()[0].nextSibling.textContent,"end");f.close();
 const placeholder=fixture(text,"",{lineStart:2,lineEnd:2});await placeholder.flush();assert.equal(placeholder.markers().length,0);placeholder.close();
});

test("Live Preview callouts receive rendered markers without changing the host DOM",async()=>{
 const text="> [!note] Title\n>\n> Body %% ::A:: c %% end";
 const f=fixture(text,'<div class="cm-editor"><div class="cm-content"><div class="cm-embed-block cm-callout"><div class="callout"><div class="callout-title-inner">Title</div><p>Body  end</p></div></div></div></div>',{editor:true});
 const dom=f.root.firstChild,contentDOM=dom.querySelector(".cm-content"),info={editor:{}};
 const view={dom,contentDOM,state:EditorState.create({doc:text,extensions:[editorInfoField.init(()=>info)]}),lineBlockAt(){return {from:0,to:this.state.doc.length};},posAtDOM(){return 0;}};info.editor.cm=view;
 const extension=f.manager.editorExtension().create(view);await f.flush();assert.equal(f.markers().length,1);assert.equal(f.markers()[0].parentElement.tagName,"P");extension.destroy();f.close();
});


test("uncertain table mappings keep a block marker rather than guessing the wrong row or cell",async()=>{
 const text="| H | Other |\n| --- | --- |\n| A %% ::A:: c %% | B |";
 const f=fixture(text,"<table><tr><th>H</th><th>Other</th></tr></table>");await f.flush();assert.equal(f.markers().length,1);assert.equal(f.markers()[0].parentElement,f.root);f.close();
});

// Obsidian can hand the post-processor the <table> itself instead of a wrapper.
for(const foreignWindow of [false,true])test(`a rendered block that is the table itself maps comments to their cell (${foreignWindow?"pop-out window":"main window"})`,()=>{
 const text="| H | Other |\n| --- | --- |\n| A %% ::A:: c %% | B |";
 const f=fixture(text,"<table><tr><th>H</th><th>Other</th></tr><tr><td>A</td><td>B</td></tr></table>");
 const table=f.root.querySelector("table"),main=new JSDOM("");
 // A note in a pop-out window: the global constructor belongs to another window.
 if(foreignWindow){globalThis.HTMLTableElement=main.window.HTMLTableElement;assert.equal(table instanceof globalThis.HTMLTableElement,false);}
 const [target]=api.markerTargets(table,text,0,2);
 assert.equal(target.container.tagName,"TD");assert.equal(target.container.textContent,"A");main.window.close();f.close();
});

test("manager unload cancels pending editor frames even before the host destroys the extension",async()=>{
 const f=fixture("",'<div class="cm-editor"><div class="cm-content"></div></div>',{editor:true}),dom=f.root.firstChild,info={editor:{}};
 const view={dom,contentDOM:dom.firstChild,state:EditorState.create({extensions:[editorInfoField.init(()=>info)]})};info.editor.cm=view;
 const extension=f.manager.editorExtension().create(view);assert.ok(f.frames.size);f.manager.destroy();assert.equal(f.frames.size,0);extension.destroy();await f.flush();f.close();
});
