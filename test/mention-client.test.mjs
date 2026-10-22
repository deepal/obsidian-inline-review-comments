import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const hostCode = `
 export class Component {
  cleanup = []; load() { this.onload?.(); } unload() { this.onunload?.(); for (const fn of this.cleanup) fn(); }
  register(fn) { this.cleanup.push(fn); } registerEvent(ref) { this.register(() => ref.off()); }
 }
 export class MarkdownView {} export class TFile {}
 import { StateField } from '@codemirror/state';
 export const editorInfoField = StateField.define({create: () => ({file: {path: 'Note.md'}}), update: (v) => v});
 globalThis.__mentionTFile = TFile; globalThis.__mentionMarkdownView = MarkdownView;
`;
const bundle = await build({ stdin: { contents: `export { MentionClient } from './src/mention-client.ts'; export * from './src/mention-format.ts'; export { mentionExtension } from './src/mention-extension.ts'; export { editorInfoField } from 'obsidian'; export { EditorState } from '@codemirror/state';`, resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false,
 plugins: [{ name: "host", setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
  builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: hostCode, resolveDir: process.cwd() }));
 } }],
});
const { MentionClient, discussionFormat, inlineFormat, mentionExtension, editorInfoField, EditorState } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const format = discussionFormat ?? inlineFormat;
const source = discussionFormat ? "comment-block" : "inline-review-comment";
const textFor = (body, id = "1") => discussionFormat ? `<comment id="${id}" author="Alice">\n${body}\n</comment>` : `%% ::Alice:: ${body} %%`;
globalThis.window = { setTimeout, clearTimeout };
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 1)); } assert.fail("request did not arrive"); }

function fixture(text = textFor("@teddy help"), available = true) {
 const events = new Map(), listeners = new Set(), submitted = [], jobs = [], views = [];
 let current = text, host, connected = available, writes = 0, enabled = true;
 const file = Object.assign(new globalThis.__mentionTFile(), { path: "Note.md" });
 const workspace = { on(name, fn) { const set = events.get(name) ?? new Set(); set.add(fn); events.set(name, set); return { off: () => set.delete(fn) }; }, trigger(name, ...args) { for (const fn of events.get(name) ?? []) fn(...args); }, iterateAllLeaves(fn) { views.forEach((view) => fn({view})); } };
 const bridge = { version: 1, tag: "teddy", attach(_source, value) { host = value; return () => {}; }, jobs: () => jobs,
  async submit(request) { submitted.push(request); jobs.push({request, state: "queued", tag: "teddy"}); for (const fn of listeners) fn(); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, retry: async () => {}, cancel() {} };
 workspace.on("ai-overview:discover-v1", (fn) => { if (connected) fn(bridge); });
 const vault = { on: workspace.on, getAbstractFileByPath: () => file, read: async () => current,
  process: async (_file, fn) => { const next = fn(current); if (next !== current) writes++; current = next; } };
 const client = new MentionClient({app: {workspace, vault}}, source, format, () => enabled);
 client.load();
 return { client, bridge, workspace, file, submitted, views, emit() { for(const fn of listeners) fn(); }, host: () => host, current: () => current, writes: () => writes,
  setText(value) { current = value; }, connect(value) { connected = value; workspace.trigger("ai-overview:bridge-changed-v1"); }, disable() { enabled = false; client.settingsChanged(); } };
}

test("absent, incompatible or blank-tag bridge has no writes or UI changes", async () => {
 const f = fixture(undefined, false);
 f.client.committed("Note.md", "", f.current()); await new Promise((r) => setImmediate(r));
 assert.equal(f.client.active, false); assert.equal(f.writes(), 0); assert.equal(f.submitted.length, 0);
 f.bridge.version = 2; f.connect(true); assert.equal(f.client.active, false);
 f.bridge.version = 1; const originalJobs=f.bridge.jobs; f.bridge.jobs=undefined; f.connect(true); assert.equal(f.client.active,false); f.bridge.jobs=originalJobs; f.bridge.tag = ""; f.connect(true); assert.equal(f.client.active, false);
});
test("load and enable do not execute existing mentions", async () => {
 const f = fixture(undefined, false); f.connect(true);
 f.client.committed("Note.md", f.current(), f.current()); await new Promise((r) => setImmediate(r));
 assert.equal(f.submitted.length, 0); assert.equal(f.writes(), 0);
});
test("committed mentions receive stable identity, context and idempotent publication", async () => {
 const f = fixture(); f.client.committed("Note.md", "", f.current());
 await until(() => f.submitted.length === 1);
 const request = f.submitted[0]; assert.ok(request.commentId); assert.equal(request.message, "@teddy help");
 assert.equal(await f.host().validate(request), true);
 await f.host().publish(request, "teddy", "Answer"); const once = f.current();
 await f.host().publish(request, "teddy", "Answer"); assert.equal(f.current(), once);
 f.client.send("Note.md", format.parse(f.current())[0]); await new Promise((r) => setTimeout(r, 5));
 assert.equal(f.submitted.length, 1);
 f.setText(f.current().replace("@teddy help", "changed")); assert.equal(await f.host().validate(request), false);
});
test("inserting another comment does not run older mentions shifted down the note", async () => {
 const before = textFor("Old @teddy request", "9");
 const after = textFor("Unrelated", "8") + "\n\n" + before;
 const f = fixture(after); f.client.committed("Note.md", before, after);
 await new Promise((r) => setTimeout(r, 5)); assert.equal(f.submitted.length, 0);
});
test("source input waits until the caret leaves; programmatic changes never execute", async () => {
 const sent = [];
 const client = { active: true, tag: "teddy", generation: "1:teddy", changed() {}, send: (...args) => sent.push(args) };
 const startText = textFor("@teddy hel");
 let state = EditorState.create({ doc: startText, extensions: [editorInfoField], selection: {anchor: startText.indexOf("hel") + 3} });
 const view = {state, hasFocus: true}; const observer = mentionExtension(client, format).create(view);
 const position = state.selection.main.head;
 let tr = state.update({ changes: {from: position, insert: "p"}, selection: {anchor: position + 1}, userEvent: "input.type" });
 observer.update({state: tr.state, startState: state, transactions: [tr], changes: tr.changes, docChanged: true, view, focusChanged: false}); state = tr.state;
 await new Promise((r) => setImmediate(r)); assert.equal(sent.length, 0);
 tr = state.update({selection: {anchor: state.doc.length}});
 observer.update({state: tr.state, startState: state, transactions: [tr], changes: tr.changes, docChanged: false, view, focusChanged: true});
 // Explicitly blur the source editor, including a caret at the comment boundary.
 view.hasFocus = false;
 observer.update({state: tr.state, startState: tr.state, transactions: [], changes: tr.changes, docChanged: false, view, focusChanged: true});
 await new Promise((r) => setImmediate(r)); assert.equal(sent.length, 1);
 const other = mentionExtension(client, format).create(view);
 tr = state.update({changes: {from: position, insert: "p"}});
 other.update({state: tr.state, startState: state, transactions: [tr], changes: tr.changes, docChanged: true, view, focusChanged: true});
 await new Promise((r) => setImmediate(r)); assert.equal(sent.length, 1);
});

test("two newly pasted mentions are submitted even when the first identity shifts the second", async () => {
 const after=textFor("@teddy first question", "1")+"\n\n"+textFor("@teddy second question", "2");
 const f=fixture(after);f.client.committed("Note.md","",after);
 await until(()=>f.submitted.length===2);
 assert.notEqual(f.submitted[0].commentId,f.submitted[1].commentId);
 assert.equal(f.submitted[1].message,"@teddy second question");
});

test("Reading views receive current metadata before rendering the queued request", async () => {
 const f=fixture();let rendered="",renders=0;
 const view=Object.assign(new globalThis.__mentionMarkdownView(),{file:f.file,getMode:()=>"preview",setViewData(text){rendered=text;},previewMode:{rerender(){renders++;}}});
 f.views.push(view);
 f.client.committed("Note.md","",f.current());await until(()=>f.submitted.length===1);
 const comment=format.parse(rendered)[0];assert.equal(comment.id,f.submitted[0].commentId);assert.ok(renders>0);
});

class Element {
 constructor(options={},parent=null){this.cls=options.cls;this.attr=options.attr??{};this.text=options.text??"";this.parent=parent;this.children=[];}
 createDiv(options){return this.append(options);} createSpan(options){return this.append(options);} createEl(_tag,options){return this.append(options);}
 append(options){const child=new Element(options,this);this.children.push(child);return child;}
 insertBefore(child,before){this.children=this.children.filter(c=>c!==child);this.children.splice(this.children.indexOf(before),0,child);}
 empty(){this.children=[];this.text="";} remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
 addEventListener(){} setText(text){this.text=text;this.children=[];}
 get textContent(){return this.text+this.children.map(c=>c.textContent).join("");}
 find(cls){if(this.cls===cls)return this;for(const child of this.children){const found=child.find(cls);if(found)return found;}}
}
test("typing uses three dots and tiny streamed activity updates preserve dots and drafts", async()=>{
 const f=fixture();const container=new Element();const draft=container.createDiv({text:"Unsent draft"});
 const owner={register(){}};
 f.client.bind(container,"Note.md",["missing"],owner);assert.equal(container.children.length,1);
 f.client.committed("Note.md","",f.current());await until(()=>f.submitted.length===1);
 const job=f.bridge.jobs()[0];job.state="running";job.detail="Reading Note.md";
 const replyBox=container.createDiv({cls:"reply-box"});
 f.client.bind(container,"Note.md",[job.request.commentId],owner,undefined,replyBox);
 assert.ok(container.children.indexOf(container.find("aio-mention-status"))<container.children.indexOf(replyBox));
 const dots=container.find("aio-mention-typing");
 assert.equal(dots.children.length,3);assert.equal(dots.attr['aria-label'],"teddy is typing");
 const stop=container.find("aio-mention-cancel");
 assert.equal(stop.attr.title,"Stop response");assert.equal(stop.attr['aria-label'],"Stop teddy's response");
 assert.ok(stop.find("aio-mention-stop-icon"));
 assert.doesNotMatch(container.textContent,/Cancel|preparing a response/);
 assert.equal(container.find("aio-mention-step").textContent,"Reading Note.md");
 job.detail="Searching linked notes";f.emit();
 assert.equal(container.find("aio-mention-typing"),dots);
 assert.equal(container.find("aio-mention-step").textContent,"Searching linked notes");
 assert.equal(container.children[0],draft);assert.equal(draft.textContent,"Unsent draft");
});

test("reply controls lock for this thread until a terminal state, retaining drafts and restoring on disconnect", async()=>{
 const f=fixture();f.client.committed("Note.md","",f.current());await until(()=>f.submitted.length===1);
 const job=f.bridge.jobs()[0];
 const input={disabled:false,value:"Draft to keep"},send={disabled:false},alreadyDisabled={disabled:true};
 const classes=new Set(),attrs=new Map(),cleanup=[];
 const composer={querySelectorAll:()=>[input,send,alreadyDisabled],addClass:c=>classes.add(c),removeClass:c=>classes.delete(c),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
 const owner={register:fn=>cleanup.push(fn)};
 f.client.bindComposer(composer,"Note.md",["other-thread"],owner);assert.equal(input.disabled,false);
 f.client.bindComposer(composer,"Note.md",[job.request.commentId],owner);
 for(const state of ["queued","running","applying"]){
  job.state=state;f.emit();assert.equal(input.disabled,true);assert.equal(send.disabled,true);
  assert.equal(attrs.get("aria-busy"),"true");assert.equal(input.value,"Draft to keep");
 }
 for(const state of ["completed","failed","cancelled"]){
  job.state=state;f.emit();assert.equal(input.disabled,false);assert.equal(send.disabled,false);assert.equal(alreadyDisabled.disabled,true);
  assert.equal(classes.size,0);assert.equal(attrs.size,0);
  job.state="running";f.emit();assert.equal(input.disabled,true);
 }
 f.connect(false);assert.equal(input.disabled,false);assert.equal(send.disabled,false);
 f.connect(true);assert.equal(input.disabled,true);
 cleanup.forEach(fn=>fn());assert.equal(input.disabled,false);assert.equal(send.disabled,false);assert.equal(input.value,"Draft to keep");
});

test("body styling follows tag and availability changes without rerendering for streamed job events",()=>{
 const f=fixture();const tags=[],cleanup=[];
 f.client.bindBody({register:fn=>cleanup.push(fn)},tag=>tags.push(tag));assert.deepEqual(tags,["teddy"]);
 f.emit();assert.deepEqual(tags,["teddy"]);
 f.bridge.tag="sonny";f.workspace.trigger("ai-overview:bridge-changed-v1");assert.deepEqual(tags,["teddy","sonny"]);
 f.connect(false);assert.deepEqual(tags,["teddy","sonny",""]);
 cleanup.forEach(fn=>fn());f.connect(true);assert.deepEqual(tags,["teddy","sonny",""]);
});
