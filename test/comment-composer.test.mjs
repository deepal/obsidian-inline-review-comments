import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { documentFixture, key } from "./helpers/dom.mjs";
globalThis.window = { setTimeout, clearTimeout };

const bundle = await build({ stdin: { contents: `
 export * from './src/drafts.ts'; export * from './src/comment-edit.ts'; export * from './src/draft-creation.ts';
 export * from './src/composer.ts'; export * from './src/card.ts'; export * from './src/card-layer.ts';
 export * from './src/auto-comment.ts'; export * from './src/editor-extension.ts'; export * from './src/reading-view.ts';
 export * from './src/parser.ts'; export { Component, Scope, Notice, MarkdownView, TFile, editorInfoField } from 'obsidian';
 export * from './src/editor-host.ts'; export * from './src/table-anchor.ts';
 export { EditorState, MapMode } from '@codemirror/state'; export { EditorView } from '@codemirror/view';
`, resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
		builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ resolveDir: process.cwd(), contents: `
 import { StateField } from '@codemirror/state';
 export const editorInfoField = StateField.define({create: () => ({file: {path: 'Note.md'}}), update: (v) => v});
 export class Component { cleanup = []; children = []; load() {} register(fn) { this.cleanup.push(fn); } unload() { for (const child of this.children) child.unload(); this.children=[]; for (const fn of this.cleanup.reverse()) fn(); this.cleanup = []; }
 addChild(child) { this.children.push(child); child.load(); return child; } removeChild(child) { child.unload(); this.children=this.children.filter(c=>c!==child); return child; }
 registerDomEvent(el, event, fn) { el.addEventListener(event, fn); this.register(() => el.removeEventListener(event, fn)); } }
 export class Scope { keys = []; register(modifiers, key, fn) { this.keys.push({modifiers,key,fn}); } }
 export class Notice { static messages = []; constructor(text) { Notice.messages.push(text); } }
 export class MarkdownView {} export class TFile {} export class MarkdownRenderChild {}
 export const MarkdownRenderer = {}; export function setIcon() {}
` }));
	} }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { DraftStore, ComposerDraft, commentMarkdown, initialCommentChange, parseComments, Component, Notice, buildComposer, buildCard, CardLayer, EditorState, EditorView, editorInfoField, insertDraft, createAutoCommentExtension, createEditorExtension, MarkdownView, MapMode, ReadingViewManager, TFile } = api;
const { editCommentChange } = api;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const apply = (text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to);

function composerFixture(post = async () => true, draft = new ComposerDraft("test")) {
	const doc = documentFixture(), owner = new Component(), scopes = [];
	const app = { scope: {}, keymap: { pushScope(scope) { scopes.push(scope); }, popScope(scope) { scopes.splice(scopes.indexOf(scope), 1); } } };
	let escaped = 0;
	const box = buildComposer(doc.body, app, owner, draft, true, post, () => { escaped++; doc.body.focus(); });
	const input = box.querySelector("textarea"), send = box.querySelector("button");
	const type = (value) => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event("input")); };
	return { doc, owner, app, scopes, box, input, send, draft, type, escaped: () => escaped };
}

test("initial posts fill one identified placeholder, preserving author, raw quote and prose", () => {
	for (const author of ["Alice", ""]) for (const quote of [undefined, "  A passage\nwith spaces  "]) {
		const before = "Before " + commentMarkdown(author, "", quote, "draft-1") + " after";
		const [target] = parseComments(before);
		const change = initialCommentChange(before, target, "First line\nSecond line");
		const after = apply(before, change), parsed = parseComments(after);
		assert.equal(parsed.length, 1); assert.equal(parsed[0].id, "draft-1"); assert.equal(parsed[0].author, author || null);
		assert.equal(parsed[0].body, "First line\nSecond line"); assert.ok(after.startsWith("Before ")); assert.ok(after.endsWith(" after"));
		if (quote) assert.ok(after.includes(`{quote}${quote}{/quote}`));
	}
});

test("posting rejects blank, changed, missing or duplicate targets and never fills a neighboring empty comment", () => {
	const before = commentMarkdown("Alice", "", null, "one") + " " + commentMarkdown("Alice", "", null, "two");
	const [target] = parseComments(before);
	assert.equal(initialCommentChange(before, target, " \n "), null);
	assert.equal(initialCommentChange(before.replace("one", "gone"), target, "text"), null);
	assert.equal(initialCommentChange(before + before, target, "text"), null);
	assert.equal(initialCommentChange(before.replace("::Alice::", "::Bob::"), target, "text"), null);
	const posted = apply(before, initialCommentChange(before, target, "posted"));
	assert.equal(initialCommentChange(posted, target, "duplicate"), null);
	assert.deepEqual(parseComments(posted).map((c) => c.body), ["posted", ""]);
	const escaped = apply(before, initialCommentChange(before, target, "literal %% <!-- aio-comment:fake -->"));
	assert.equal(parseComments(escaped).length, 2); assert.equal(parseComments(escaped)[0].id, "one");
});

test("edits preserve raw authors, quotations, identities, agent metadata and neighboring replies", () => {
	for (const raw of [
		"%% :: Alice :: {quote}  Verbatim\npassage  {/quote} Original <!-- aio-comment:one --> %%",
		"%% Original %%",
		"%% ::Agent:: Original <!-- aio-comment:two --> <!-- aio-reply:request-one --> %%",
	]) {
		const before = "Prose " + raw + " " + commentMarkdown("Bob", "Reply", null, "reply");
		const [target] = parseComments(before), changed = apply(before, editCommentChange(before, target, "Edited\nsecond line"));
		const [edited, reply] = parseComments(changed);
		assert.equal(edited.body, "Edited\nsecond line"); assert.equal(edited.author, target.author); assert.equal(edited.quote, target.quote);
		assert.equal(edited.id, target.id); assert.equal(edited.replyTo, target.replyTo); assert.equal(reply.body, "Reply");
		if (target.quote) assert.ok(changed.includes("{quote}  Verbatim\npassage  {/quote}"));
		if (target.author === "Alice") assert.ok(changed.includes(":: Alice ::"));
		const noOp = editCommentChange(before, target, target.body); assert.equal(apply(before, noOp), before);
		assert.equal(editCommentChange(before, target, "  "), null);
		assert.equal(editCommentChange(before.replace("Original", "External edit"), target, "overwrite"), null);
	}
});

test("editing via pencil prefills the selected message, saves with Ctrl+Enter and cancels without changing source", async () => {
	const f = composerFixture(), drafts = new DraftStore(); f.box.remove();
	const thread = parseComments(commentMarkdown("Alice", "Root", null, "one") + " " + commentMarkdown("Bob", "Reply", null, "two"));
	let saved = [], escaped = 0;
	const cb = { app: f.app, drafts, sourcePath: "Note.md", onEscape() { escaped++; f.doc.body.focus(); }, onPost: async () => true, onReply: async () => true, onEdit: async (target, body) => { saved.push([target.id, body]); return true; }, onDelete() {}, onResolve() {}, renderBody(el, text) { el.setText(text); } };
	const owner = new Component(), card = buildCard(thread, cb, owner); f.doc.body.appendChild(card);
	card.querySelectorAll(".irc-edit")[1].click();
	let input = card.querySelector(".irc-edit-composer").querySelector("textarea");
	assert.equal(input.value, "Reply"); assert.ok(f.doc.activeElement === input);
	input.value = "Updated reply"; input.dispatchEvent(new Event("input")); key(input, { key: "Escape" });
	assert.equal(escaped, 1); assert.equal(input.value, "Updated reply"); assert.ok(card.isConnected);
	assert.equal(card.classList.contains("irc-collapsed"), false); assert.equal(saved.length, 0);
	input.focus(); key(input, { ctrlKey: true }); await tick();
	assert.deepEqual(saved, [["two", "Updated reply"]]); assert.equal(card.querySelector(".irc-edit-composer"), null);
	card.querySelectorAll(".irc-edit")[0].click(); input = card.querySelector(".irc-edit-composer").querySelector("textarea");
	assert.equal(input.value, "Root"); input.value = "Discard this"; input.dispatchEvent(new Event("input"));
	card.querySelector(".irc-edit-cancel").click(); assert.equal(card.querySelector(".irc-edit-composer"), null); assert.equal(saved.length, 1);
	owner.unload(); assert.equal(f.scopes.length, 0);
});

test("unfinished edits survive card recreation and failed saves", async () => {
	const f = composerFixture(), drafts = new DraftStore(); f.box.remove();
	const source = commentMarkdown("Alice", "Original", null, "one"), target = parseComments(source)[0];
	const cb = { app: f.app, drafts, sourcePath: "Note.md", onEscape() {}, onPost: async () => true, onReply: async () => true, onEdit: async () => false, onDelete() {}, onResolve() {}, renderBody(el, text) { el.setText(text); } };
	const firstOwner = new Component(), first = buildCard([target], cb, firstOwner); f.doc.body.appendChild(first); first.querySelector(".irc-edit").click();
	let input = first.querySelector(".irc-edit-composer").querySelector("textarea"); input.value = "Unfinished"; input.setSelectionRange(2, 5); input.dispatchEvent(new Event("input"));
	firstOwner.unload(); first.remove();
	const secondOwner = new Component(), second = buildCard(parseComments("Prefix " + source), cb, secondOwner); f.doc.body.appendChild(second);
	input = second.querySelector(".irc-edit-composer").querySelector("textarea"); assert.equal(input.value, "Unfinished"); assert.equal(input.selectionStart, 2);
	key(input, { metaKey: true }); await tick(); assert.equal(input.value, "Unfinished"); assert.ok(second.querySelector(".irc-edit-composer")); secondOwner.unload();
});

test("legacy editing follows source movement and survives its own staged body update", () => {
	const drafts = new DraftStore(), source = "Before %% ::Alice:: Original %% After";
	drafts.observe("Note.md", source); const target = parseComments(source)[0], draft = drafts.edit("Note.md", target); draft.beginEdit(target);
	const moved = "Extra " + source; drafts.observe("Note.md", moved);
	assert.equal(draft.target.from, target.from + 6);
	const staged = apply(moved, editCommentChange(moved, draft.target, "Changed")); drafts.observe("Note.md", staged);
	assert.equal(drafts.edit("Note.md", parseComments(staged)[0]), draft);
	drafts.observe("Note.md", moved); assert.equal(drafts.edit("Note.md", parseComments(moved)[0]), draft);
	assert.ok(editCommentChange(moved, draft.target, "Retry"));
});

test("replies append after messages added since the card rendered", () => {
	const before = commentMarkdown("Alice", "Root", null, "one");
	const after = before + " " + commentMarkdown("Bob", "New reply", null, "two");
	assert.equal(api.findReplyEnd(after, parseComments(before)), after.length);
	assert.equal(api.findReplyEnd(after.replace("Root", "Changed"), parseComments(before)), null);
});

test("commands and typed %% share identified draft creation; code and disabled expansion stay untouched", () => {
	for (const author of ["", "Alice"]) {
		const drafts = new DraftStore();
		const view = { state: EditorState.create({ doc: "Prose", extensions: [editorInfoField] }), dispatch(spec) { this.state = this.state.update(spec).state; } };
		assert.equal(insertDraft(view, drafts, author, 5, 5, "Prose"), true);
		const [comment] = parseComments(view.state.doc.toString()); assert.equal(comment.quote, "Prose"); assert.equal(comment.body, ""); assert.ok(drafts.initial("Note.md", comment));
		const plugin = { settings: { enabled: true, autoInsertOnType: true, username: author }, drafts };
		const extension = createAutoCommentExtension(plugin);
		view.state = EditorState.create({ doc: "%", extensions: [editorInfoField, extension] });
		const handler = view.state.facet(EditorView.inputHandler)[0];
		assert.equal(handler(view, 1, 1, "%"), true); assert.ok(parseComments(view.state.doc.toString())[0].id);
		plugin.settings.enabled = false; assert.equal(handler(view, 1, 1, "%"), false);
		view.state = EditorState.create({ doc: "`code`", extensions: [editorInfoField] });
		assert.equal(insertDraft(view, drafts, author, 2, 2), false);
	}
});

test("draft text and selection survive replacement cards and reopening a note during the session", () => {
	const store = new DraftStore(), state = store.start("Note.md", "id");
	state.update("unfinished", 2, 6, "backward");
	const f = composerFixture(async () => true, state); f.owner.unload(); f.box.remove();
	const reopened = composerFixture(async () => true, store.initial("Note.md", parseComments(commentMarkdown("", "", null, "id"))[0]));
	assert.equal(reopened.input.value, "unfinished"); assert.equal(reopened.input.selectionStart, 2); assert.equal(reopened.input.selectionEnd, 6);
	assert.equal(reopened.input.selectionDirection, "backward");
	assert.notEqual(store.start("Other.md", "id"), state);
	store.clear(); assert.equal(store.initial("Note.md", parseComments(commentMarkdown("", "", null, "id"))[0]), undefined);
});

test("legacy reply drafts follow shifted prose without merging identical neighbors", () => {
	const store = new DraftStore(), before = "prefix\n%% same %%\n\n%% same %%";
	store.observe("Note.md", before); const comments = parseComments(before);
	const first = store.reply("Note.md", comments[0]), second = store.reply("Note.md", comments[1]);
	first.text = "one"; second.text = "two";
	const state = EditorState.create({ doc: before });
	const tr = state.update({ changes: { from: 0, insert: "More prose\n" } });
	store.observe("Note.md", tr.newDoc.toString(), (pos) => tr.changes.mapPos(pos, 1, MapMode.TrackAfter) ?? -1);
	const shifted = parseComments(tr.newDoc.toString());
	assert.equal(store.reply("Note.md", shifted[0]), first); assert.equal(store.reply("Note.md", shifted[1]), second);
	const deleted = tr.state.update({ changes: { from: shifted[0].from, to: shifted[1].from } });
	store.observe("Note.md", deleted.newDoc.toString(), (pos) => deleted.changes.mapPos(pos, 1, MapMode.TrackAfter) ?? -1);
	assert.equal(store.reply("Note.md", parseComments(deleted.newDoc.toString())[0]), second);
});

test("switching files does not map a retained draft through another file's transaction", () => {
	const store = new DraftStore(), text = "A long paragraph\n%% Legacy comment %%";
	store.observe("Note.md", text); const draft = store.reply("Note.md", parseComments(text)[0]); draft.text = "retained";
	store.observe("Note.md", "Extra\n" + text, () => { assert.fail("wrong document mapping"); }, "Different file");
	assert.equal(store.reply("Note.md", parseComments("Extra\n" + text)[0]), draft);
});

test("Enter stays multiline; Cmd/Ctrl+Enter post and ignore repeat, IME and blank text", async () => {
	const posted = []; const f = composerFixture(async (text) => { posted.push(text); return true; });
	f.input.focus(); f.type("First\nsecond");
	assert.equal(key(f.input, {}).defaultPrevented, false); assert.equal(key(f.input, { shiftKey: true }).defaultPrevented, false);
	key(f.input, { metaKey: true, repeat: true }); key(f.input, { ctrlKey: true, isComposing: true }); assert.equal(posted.length, 0);
	f.input.dispatchEvent(new Event("compositionstart")); f.send.dispatchEvent(new Event("click")); assert.equal(posted.length, 0);
	f.input.dispatchEvent(new Event("compositionend")); key(f.input, { metaKey: true }); await tick();
	assert.deepEqual(posted, ["First\nsecond"]); assert.equal(f.input.value, "");
	f.type("  "); key(f.input, { ctrlKey: true }); await tick(); assert.equal(posted.length, 1);
	f.type("Ctrl submission"); key(f.input, { ctrlKey: true }); await tick(); assert.equal(posted[1], "Ctrl submission");
	f.owner.unload();
});

test("composers expand for long input, shrink on clearing, reflow on width changes and clean up observers", () => {
	const f = composerFixture();
	const observer = ResizeObserver.instances.find((item) => item.observed.has(f.input));
	const compactHeight = parseFloat(f.input.style.height);
	f.input.scrollHeight = 600; f.type("A lengthy draft\n".repeat(30));
	assert.ok(parseFloat(f.input.style.height) >= f.input.scrollHeight);
	assert.ok(parseFloat(f.input.style.height) > 140); assert.equal(f.draft.text, f.input.value);
	f.input.clientWidth = 100; f.input.scrollHeight = 1000; observer.callback();
	assert.ok(parseFloat(f.input.style.height) >= 1000);
	f.input.scrollHeight = 28; f.draft.clear();
	assert.ok(parseFloat(f.input.style.height) < compactHeight); assert.equal(f.input.value, "");
	f.owner.unload(); assert.equal(observer.observed.size, 0);
	const lastHeight = f.input.style.height; f.input.clientWidth = 50; observer.callback();
	assert.equal(f.input.style.height, lastHeight);
});

test("scope bindings own native shortcuts only while focused; Escape preserves the draft", () => {
	const f = composerFixture(); f.type("keep me"); f.input.focus();
	assert.equal(f.scopes.length, 1); const scope = f.scopes[0];
	assert.ok(scope.keys.some((entry) => entry.key === "Enter" && entry.modifiers[0] === "Meta"));
	assert.ok(scope.keys.some((entry) => entry.key === "Enter" && entry.modifiers[0] === "Ctrl"));
	key(f.input, { key: "Escape" }); assert.equal(f.escaped(), 1); assert.equal(f.draft.text, "keep me"); assert.equal(f.scopes.length, 0);
	f.input.focus(); f.owner.unload(); assert.equal(f.scopes.length, 0);
});

test("failed or stale saves retain drafts; in-flight posts are locked across panes", async () => {
	let finish, calls = 0;
	const draft = new ComposerDraft("shared"), f = composerFixture(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, draft);
	const other = composerFixture(async () => { calls++; return true; }, draft);
	f.type("unsaved"); key(f.input, { metaKey: true }); key(f.input, { ctrlKey: true }); other.send.dispatchEvent(new Event("click"));
	assert.equal(calls, 1); assert.equal(other.input.disabled, true); assert.equal(f.draft.text, "unsaved");
	finish(false); await tick(); assert.equal(f.input.value, "unsaved"); assert.equal(other.input.disabled, false);
	assert.match(Notice.messages.at(-1), /draft has been kept/);
	const failed = composerFixture(async () => { throw new Error("disk full"); }); failed.type("retry me"); failed.send.dispatchEvent(new Event("click")); await tick();
	assert.equal(failed.input.value, "retry me"); assert.equal(failed.draft.submitting, false);
});

test("initial cards show one comment composer, then rendered text and a reply composer", () => {
	const f = composerFixture(), drafts = new DraftStore(); drafts.start("Note.md", "id");
	const cb = { app: f.app, drafts, sourcePath: "Note.md", onEscape() {}, onPost: async () => true, onReply: async () => true, onDelete() {}, onResolve() {}, renderBody(el, text) { el.setText(text); } };
	const initial = parseComments(commentMarkdown("Alice", "", "Quoted text", "id"));
	const card = buildCard(initial, cb, new Component()); assert.equal(card.querySelectorAll("textarea").length, 1); assert.ok(card.querySelector(".irc-initial")); assert.equal(card.querySelector(".irc-reply"), null);
	const posted = buildCard(parseComments(commentMarkdown("Alice", "Posted", "Quoted text", "id")), cb, new Component());
	assert.equal(posted.querySelector(".irc-initial"), null); assert.ok(posted.querySelector(".irc-reply")); assert.equal(posted.querySelector(".irc-rendered-body").textContent, "Posted");
});

test("card redraws preserve focused draft and selection without stealing a later focus", async () => {
	const f = composerFixture(), drafts = new DraftStore(); f.box.remove(); drafts.start("Note.md", "id").update("text", 1, 3, "forward");
	const cb = { app: f.app, drafts, sourcePath: "Note.md", onEscape() {}, onPost: async () => true, onReply: async () => true, onDelete() {}, onResolve() {}, renderBody() {} };
	const layer = new CardLayer(f.doc.body, 240), source = commentMarkdown("Alice", "", null, "id");
	layer.render([{ thread: parseComments(source), top: 0 }], cb);
	const original = layer.el.querySelector("textarea"); original.focus();
	layer.render([{ thread: parseComments("Prose " + source), top: 0 }], cb); await tick();
	const replacement = layer.el.querySelector("textarea"); assert.notEqual(original, replacement); assert.equal(f.doc.activeElement, replacement); assert.equal(replacement.value, "text"); assert.equal(replacement.selectionStart, 1);
	const note = f.doc.body.createDiv();
	layer.render([{ thread: parseComments("More prose " + source), top: 0 }], cb); note.focus(); await tick();
	// Focusing the note after a synchronous redraw should win over deferred restoration.
	assert.ok(f.doc.activeElement === note);
	layer.destroy(); assert.equal(f.scopes.length, 0);
});

test("cards restack after asynchronous body sizing and disconnect on teardown", () => {
	const f = composerFixture(), drafts = new DraftStore(); f.box.remove();
	const cb = { app: f.app, drafts, sourcePath: "Note.md", onEscape() {}, onPost: async () => true, onReply: async () => true, onDelete() {}, onResolve() {}, renderBody() {} };
	const layer = new CardLayer(f.doc.body, 240);
	const comments = parseComments(commentMarkdown("Alice", "First", null, "one") + "\n\n" + commentMarkdown("Bob", "Second", null, "two"));
	layer.render(comments.map((comment) => ({ thread: [comment], top: 0 })), cb);
	const cards = layer.el.querySelectorAll(".irc-card"); assert.equal(cards[1].style.top, "88px");
	cards[0].offsetHeight = 200; layer.resizeObserver.callback(); assert.equal(cards[1].style.top, "208px");
	layer.destroy(); assert.equal(layer.resizeObserver.observed.size, 0);
});

test("detaching a Reading view releases its cards without waiting for another draw", async () => {
	let child, frame, destroyed = false;
	const manager = new ReadingViewManager({}); const wrapper = { isConnected: true };
	const scroller = { removeEventListener() {}, classList: { remove() {} } };
	const state = { wrapper, scroller, text: "", sourcePath: "", frame: null, resizeObserver: { disconnect() {} }, tables: { destroy() {} }, layer: { destroy() { destroyed = true; } } };
	manager.ensureState = () => { manager.states.set(wrapper, state); return state; }; manager.schedule = () => {};
	const el = { dataset: {}, isConnected: true, closest: (selector) => selector === ".markdown-reading-view" ? wrapper : scroller, win: { requestAnimationFrame(fn) { frame = fn; return 1; } } };
	manager.handleBlock(el, { getSectionInfo: () => ({ text: "%% comment %%", lineStart: 0, lineEnd: 0 }), sourcePath: "Note.md", addChild(value) { child = value; } });
	child.onload(); frame(); wrapper.isConnected = false; child.onunload(); await tick();
	assert.equal(destroyed, true); assert.equal(manager.states.size, 0);
});

test("source write failure rolls back its insertion while keeping concurrent prose edits", async () => {
	const doc = documentFixture(), drafts = new DraftStore(); let reject;
	const info = Object.assign(new MarkdownView(), { file: { path: "Note.md" }, save: () => new Promise((_r, fail) => { reject = fail; }) });
	const plugin = { drafts, settings: { cardWidth: 240 }, editorRenderers: new Set(), mentions: { committed() { assert.fail("failed save must not commit a mention"); } } };
	let renderer;
	const view = { state: EditorState.create({ doc: "Before after", extensions: [editorInfoField.init(() => info)] }), dom: doc.body, contentDOM: doc.body, scrollDOM: doc.body, requestMeasure() {},
		dispatch(spec) { const previous = this.state, tr = previous.update(spec); this.state = tr.state; renderer?.update({ state: tr.state, startState: previous, view: this, transactions: [tr], changes: tr.changes, docChanged: tr.docChanged }); } };
	renderer = createEditorExtension(plugin).create(view);
	const pending = renderer.commit(view, { from: 7, to: 7, insert: "posting " });
	view.dispatch({ changes: { from: 0, insert: "New " } }); reject(new Error("save failed"));
	await assert.rejects(pending); assert.equal(view.state.doc.toString(), "New Before after"); renderer.destroy();
});

test("Reading view awaits persistence and rejects missing targets without agent notifications", async () => {
	const file = new TFile(); let text = commentMarkdown("Alice", "", null, "id"), notifications = 0;
	const plugin = { app: { vault: { getAbstractFileByPath: () => file, process: async (_f, edit) => { text = edit(text); } } }, mentions: { committed() { notifications++; } } };
	const manager = new ReadingViewManager(plugin); manager.schedule = () => {};
	const state = { sourcePath: "Note.md" }, target = parseComments(text)[0];
	assert.equal(await manager.write(state, (data) => initialCommentChange(data, target, "Posted")), true);
	assert.equal(parseComments(text)[0].body, "Posted"); assert.equal(notifications, 1);
	assert.equal(await manager.write(state, (data) => initialCommentChange(data, target, "Again")), false); assert.equal(notifications, 1);
});

function tableEditorFixture(text = "Prose\n\n| Header | Other |\n| --- | --- |\n| cell | end |", document = documentFixture(), sharedPlugin) {
	const doc = document, info = { file: { path: "Note.md" }, editor: { editorComponent: {} } };
	const drafts = sharedPlugin?.drafts ?? new DraftStore(), app = { scope: {}, keymap: { pushScope() {}, popScope() {} } };
	const plugin = sharedPlugin ?? { drafts, app, settings: { enabled: true, cardWidth: 240, username: "Alice" }, editorRenderers: new Set(), mentions: { bind() {}, bindComposer() {}, bindBody() {}, committed() {}, changed() {} } };
	function editor(parent, source) {
		const dom = parent.createDiv({ cls: "cm-editor" }), scrollDOM = dom.createDiv({ cls: "cm-scroller" }), contentDOM = scrollDOM.createDiv({ cls: "cm-content" });
		const measures = [];
		const view = { dom, scrollDOM, contentDOM, documentTop: 0, state: EditorState.create({ doc: source, extensions: [editorInfoField.init(() => info)] }),
			get hasFocus() { return dom.contains(doc.activeElement); },
			requestMeasure(measure) { measures.push(measure); }, focus() { contentDOM.focus(); },
			lineBlockAt(at) { const line = this.state.doc.lineAt(at); return { from: line.from, to: line.to, top: (line.number - 1) * 100 }; },
			dispatch(spec) {
				const previous = this.state, tr = previous.update(spec); this.state = tr.state;
				this.renderer?.update({ state: tr.state, startState: previous, view: this, transactions: [tr], changes: tr.changes, docChanged: tr.docChanged });
			},
			flush() { let limit = 20; while (measures.length && limit--) measures.shift().read(); assert.ok(limit > 0, "draws must settle"); },
		};
		scrollDOM.scrollTop = 0;
		return view;
	}
	const root = editor(doc.body, text); info.editor.cm = root;
	root.renderer = createEditorExtension(plugin).create(root);
	const widget = root.contentDOM.createDiv({ cls: "cm-table-widget" }), table = widget.createEl("table"), tbody = table.createEl("tbody"), row = tbody.createEl("tr"), cell = row.createEl("td");
	const nested = editor(cell, "cell"); info.editor.editorComponent.activeCM = nested;
	nested.renderer = createEditorExtension(plugin).create(nested);
	const sync = () => { const before = root.state.doc.toString(); root.dispatch({ changes: { from: 0, to: before.length, insert: text.replace("cell", nested.state.doc.toString()) } }); };
	const destroy = () => { root.renderer.destroy(); nested.renderer.destroy(); root.dom.remove(); };
	return { doc, info, plugin, drafts, root, nested, widget, table, row, sync, destroy };
}

test("embedded cell editors own no cards, gutter, or partial-document draft snapshot", () => {
	const f = tableEditorFixture(); const full = f.root.state.doc.toString();
	f.root.flush(); f.nested.flush();
	assert.equal(api.owningNoteView(f.nested), f.root);
	assert.equal(f.nested.renderer.layer, null); assert.equal(f.nested.scrollDOM.querySelector(".irc-margin-layer"), null);
	assert.equal(f.nested.contentDOM.classList.contains("irc-note-content"), false);
	assert.equal(f.nested.scrollDOM.classList.contains("irc-has-comments"), false);
	f.nested.dispatch({ changes: { from: 0, insert: "edited " } }); f.nested.flush();
	assert.equal(f.drafts.snapshots.get("Note.md"), full);
	f.destroy(); assert.equal(f.root.contentDOM.classList.contains("irc-note-content"), false);
});

test("cached editors cannot resurrect a renderer after plugin teardown", () => {
	const f = tableEditorFixture(), original = f.root.state.doc.toString();
	f.root.renderer.destroy(); f.root.renderer.destroy();
	f.nested.renderer.destroy();
	f.root.dispatch({ changes: { from: 0, insert: "New " } });
	f.root.flush(); f.nested.flush();
	assert.equal(f.root.scrollDOM.querySelector(".irc-margin-layer"), null);
	assert.equal(f.drafts.snapshots.get("Note.md"), original);
	assert.equal(f.plugin.editorRenderers.size, 0); f.destroy();
});

test("cell commands retain selected prose, insert once, and focus the outside draft after sync", async () => {
	const f = tableEditorFixture();
	f.nested.dispatch({ selection: { anchor: 0, head: 4 } });
	assert.equal(f.root.renderer.insertComment(f.info.editor), true);
	const [comment] = parseComments(f.nested.state.doc.toString());
	assert.equal(comment.quote, "cell"); assert.ok(f.nested.state.doc.toString().startsWith("cell%%"));
	await tick(); f.root.flush(); assert.ok(f.root.renderer.pendingFocus, "wait for parent synchronization");
	f.sync(); f.root.flush(); await tick();
	assert.equal(f.root.renderer.layer.el.querySelectorAll(".irc-card").length, 1);
	assert.equal(parseComments(f.root.state.doc.toString()).length, 1);
	assert.ok(f.root.renderer.layer.el.contains(f.doc.activeElement));
	assert.equal(f.doc.activeElement.getAttribute("aria-label"), "Write a comment");
	f.doc.activeElement.value = "draft text"; f.doc.activeElement.dispatchEvent(new Event("input"));
	f.nested.renderer.destroy(); f.nested.dom.remove(); f.root.renderer.draw(f.root);
	assert.equal(f.doc.activeElement.value, "draft text"); f.destroy();
});

test("a cell command rejected by parsing is handled without a raw-insertion fallback", () => {
	const f = tableEditorFixture();
	f.nested.dispatch({ changes: { from: 0, to: 4, insert: "`code`" }, selection: { anchor: 3 } });
	assert.equal(f.root.renderer.insertComment(f.info.editor), true);
	assert.equal(f.nested.state.doc.toString(), "`code`"); f.destroy();
});

test("typed cell expansion relays focus and preserves the draft when its cell is replaced", async () => {
	const f = tableEditorFixture();
	f.nested.dispatch({ changes: { from: 4, insert: "%" } }); f.nested.focus();
	const extension = createAutoCommentExtension({ ...f.plugin, settings: { ...f.plugin.settings, autoInsertOnType: true } });
	const handler = EditorState.create({ extensions: [extension] }).facet(EditorView.inputHandler)[0];
	assert.equal(handler(f.nested, 5, 5, "%"), true);
	const [comment] = parseComments(f.nested.state.doc.toString()); await tick();
	f.nested.renderer.destroy(); f.nested.dom.remove(); f.sync(); f.root.flush(); await tick();
	assert.equal(f.doc.activeElement.getAttribute("aria-label"), "Write a comment");
	assert.ok(f.drafts.initial("Note.md", comment)); f.destroy();
});

test("pending cell focus cancels on user navigation, file switches, and renderer teardown", async () => {
	for (const action of ["pointer", "keyboard", "focus", "file", "destroy"]) {
		const f = tableEditorFixture(); f.root.renderer.insertComment(f.info.editor); await tick();
		const target = f.doc.body.createEl("button");
		if (action === "pointer") f.doc.dispatchEvent(new Event("pointerdown"));
		if (action === "keyboard") f.doc.dispatchEvent(new Event("keydown"));
		if (action === "focus") target.focus();
		if (action === "file") f.info.file = { path: "Elsewhere.md" };
		if (action === "destroy") f.root.renderer.destroy();
		f.sync(); f.root.flush(); await tick();
		assert.equal(f.root.renderer.pendingFocus, null); assert.equal(f.root.renderer.layer.el.contains(f.doc.activeElement), false);
		assert.ok(f.drafts.drafts.size > 0, "cancellation must retain the draft"); f.destroy(); target.remove();
	}
});

test("navigation before draft-focus forwarding cannot arm a stale request", async () => {
	const f = tableEditorFixture(); f.root.renderer.insertComment(f.info.editor);
	f.info.file = { path: "Elsewhere.md" }; await tick(); f.root.flush();
	assert.equal(f.root.renderer.pendingFocus, null); f.destroy();
});

test("separate note panes keep their own cards and only the originating pane gains focus", async () => {
	const f = tableEditorFixture(), other = tableEditorFixture(undefined, f.doc, f.plugin);
	f.root.renderer.insertComment(f.info.editor); await tick(); f.sync();
	other.root.dispatch({ changes: { from: 0, to: other.root.state.doc.length, insert: f.root.state.doc.toString() } });
	f.root.flush(); other.root.flush(); await tick();
	assert.equal(f.root.renderer.layer.el.querySelectorAll(".irc-card").length, 1);
	assert.equal(other.root.renderer.layer.el.querySelectorAll(".irc-card").length, 1);
	assert.ok(f.root.renderer.layer.el.contains(f.doc.activeElement)); f.destroy(); other.destroy();
});

test("detached editors defer DOM fallback ownership until attachment", () => {
	const f = tableEditorFixture(), original = EditorView.findFromDOM;
	try {
		delete f.info.editor.cm; EditorView.findFromDOM = (dom) => dom === f.root.dom ? f.root : f.nested;
		f.root.dom.remove(); assert.equal(api.owningNoteView(f.root), null);
		f.doc.body.appendChild(f.root.dom); assert.equal(api.owningNoteView(f.root), f.root); assert.equal(api.owningNoteView(f.nested), f.root);
	} finally { EditorView.findFromDOM = original; f.destroy(); }
});

test("editor row anchors use rendered row bounds and retain block anchors off screen", () => {
	const source = "| Header | Other |\n| --- | --- |\n| cell " + commentMarkdown("Alice", "", null, "row") + " | end |";
	const f = tableEditorFixture(source); f.drafts.start("Note.md", "row");
	f.table.rows = [f.table.createEl("tr"), f.row]; f.row.top = 450;
	f.root.posAtDOM = () => 0; f.root.lineBlockAt = () => ({ from: 0, to: source.length, top: 100 });
	f.root.flush(); assert.equal(f.root.renderer.layer.el.querySelector(".irc-card").style.top, "450px");
	f.widget.remove(); f.root.renderer.draw(f.root);
	assert.equal(f.root.renderer.layer.el.querySelector(".irc-card").style.top, "100px"); f.destroy();
});

test("Reading view anchors table comments to their source row", () => {
	const source = "| Header | Other |\n| --- | --- |\n| cell " + commentMarkdown("Alice", "", null, "row") + " | end |";
	const f = tableEditorFixture(source); f.drafts.start("Note.md", "row");
	f.table.rows = [f.table.createEl("tr"), f.row]; f.row.top = 450;
	const manager = new ReadingViewManager(f.plugin);
	manager.collectBlocks = () => [{ el: f.widget, lineStart: 0, lineEnd: 2 }];
	const state = { wrapper: f.root.dom, scroller: f.root.scrollDOM, layer: new CardLayer(f.root.scrollDOM, 240), sourcePath: "Note.md", text: source, tables: new api.TableResizeObserver(() => {}) };
	manager.draw(state); assert.equal(state.layer.el.querySelector(".irc-card").style.top, "450px");
	f.table.rows.pop(); manager.draw(state); assert.equal(state.layer.el.querySelector(".irc-card").style.top, "0px");
	state.tables.destroy(); state.layer.destroy(); f.destroy();
});

test("table composers await the outer document, save it, and notify mentions with current offsets", async () => {
 const text="Intro\n\n| A | B |\n| --- | --- |\n| cell "+commentMarkdown("Alice","",null,"draft-one")+" | end |";
 const f=tableEditorFixture(text);let saves=0;const commits=[];
 f.plugin.mentions.committed=(path,before,after)=>commits.push({path,before,after});
 const host=Object.assign(new MarkdownView(),{editor:f.info.editor,save:async()=>{saves++;assert.match(f.root.state.doc.toString(),/@teddy table question/);}});
 f.plugin.app.workspace={iterateAllLeaves:fn=>fn({view:host})};
 const dispatch=f.root.dispatch.bind(f.root);let deliver;
 f.root.dispatch=spec=>{deliver=()=>dispatch(spec)};
 const pending=f.root.renderer.post(f.root,parseComments(text)[0],"@teddy table question");
 await tick();assert.equal(commits.length,0);assert.equal(saves,0);
 deliver();assert.equal(await pending,true);
 assert.equal(commits.length,1);assert.equal(saves,1);assert.match(commits[0].after,/@teddy table question/);
 assert.equal(parseComments(commits[0].after)[0].id,"draft-one");
 f.destroy();
});

test("table comment posts and replies encode newlines and pipes without changing neighboring cells", async () => {
 const text="| A | B |\n| --- | --- |\n| cell "+commentMarkdown("Alice","",null,"draft-one")+" | end |";
 const f=tableEditorFixture(text);
 assert.equal(await f.root.renderer.post(f.root,parseComments(text)[0],"@teddy compare a | b\nSecond line"),true);
 const after=f.root.state.doc.toString();assert.equal(after.split("\n").length,3);assert.match(after,/a \\\| b<br>Second line/);
 assert.equal(parseComments(after)[0].body,"@teddy compare a | b\nSecond line");
 assert.equal(await f.root.renderer.reply(f.root,parseComments(after),"@teddy follow up | question\nMore context"),true);
 const replied=f.root.state.doc.toString();assert.equal(replied.split("\n").length,3);assert.ok(replied.endsWith(" | end |"));
 assert.deepEqual(parseComments(replied).map(c=>c.body),["@teddy compare a | b\nSecond line","@teddy follow up | question\nMore context"]);
 f.destroy();
});

test("editing container comments retains raw author, excerpt and request metadata",()=>{
 for(const before of [
  "> %%\n> :: Alice :: {quote}Exact excerpt{/quote} Original <!-- aio-comment:one -->\n> %%",
  "| A | B |\n| --- | --- |\n| %%<br>:: Alice :: {quote}Exact excerpt{/quote} Original <!-- aio-comment:one --><br>%% | end |",
 ]){
  const [target]=parseComments(before),change=editCommentChange(before,target,"@teddy edited | body\nNext line");
  const after=apply(before,change),[edited]=parseComments(after);
  assert.equal(edited.author,"Alice");assert.equal(edited.quote,"Exact excerpt");assert.equal(edited.id,"one");
  assert.equal(edited.body,"@teddy edited | body\nNext line");assert.ok(after.includes(":: Alice ::"));
  assert.ok(after.includes("{quote}Exact excerpt{/quote}"));
 }
});

test("retired table editors cannot become the active source for a note",()=>{
 const f=tableEditorFixture();f.nested.focus();assert.equal(api.activeEditorView(f.root),f.nested);
 f.nested.dom.remove();assert.equal(api.activeEditorView(f.root),f.root);f.destroy();
});

test("editing an indented comment handles long whitespace without overlapping matches",()=>{
 const before="    "+commentMarkdown("Alice","Original"+" ".repeat(128)+"body",null,"indented");
 const [target]=parseComments(before),after=apply(before,editCommentChange(before,target,"Edited body"));
 assert.equal(parseComments(after)[0].body,"Edited body");assert.equal(parseComments(after)[0].id,"indented");
});
