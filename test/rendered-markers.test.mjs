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
 win.Node.prototype.instanceOf = function (type) { return this instanceof type; };
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
test("a rendered block that is the table itself maps comments to their cell",()=>{
 const text="| H | Other |\n| --- | --- |\n| A %% ::A:: c %% | B |";
 const f=fixture(text,"<table><tr><th>H</th><th>Other</th></tr><tr><td>A</td><td>B</td></tr></table>");
 const [target]=api.markerTargets(f.root.querySelector("table"),text,0,2);
 assert.equal(target.container.tagName,"TD");assert.equal(target.container.textContent,"A");f.close();
});

test("manager unload cancels pending editor frames even before the host destroys the extension",async()=>{
 const f=fixture("",'<div class="cm-editor"><div class="cm-content"></div></div>',{editor:true}),dom=f.root.firstChild,info={editor:{}};
 const view={dom,contentDOM:dom.firstChild,state:EditorState.create({extensions:[editorInfoField.init(()=>info)]})};info.editor.cm=view;
 const extension=f.manager.editorExtension().create(view);assert.ok(f.frames.size);f.manager.destroy();assert.equal(f.frames.size,0);extension.destroy();await f.flush();f.close();
});
