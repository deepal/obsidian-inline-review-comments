import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
	stdin: { contents: `export * from './src/thread-count-status.ts'; export { MarkdownView, Platform } from 'obsidian';`, resolveDir: process.cwd() },
	bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
		builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `
export class Component {
  events = [];
  registerEvent(event) { this.events.push(event); }
  load() { this.onload(); }
  unload() { this.onunload(); this.events.forEach(event => event.off()); }
}
export class MarkdownView {
  mode = 'source'; reads = 0;
  constructor(path, text) { this.file = { path }; this.text = text; }
  getMode() { return this.mode; }
  getViewData() { this.reads++; return this.text; }
}
export const Platform = { isMobile: false };
export function setTooltip(el, text) { el.tooltip = text; }
` }));
	} }],
});
const { ThreadCountStatus, MarkdownView, Platform } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function events() {
	const listeners = new Map();
	return {
		on(name, callback) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(callback);
			return { off: () => listeners.get(name).delete(callback) };
		},
		emit(name, ...args) { for (const callback of listeners.get(name) ?? []) callback(...args); },
		total() { return [...listeners.values()].reduce((total, set) => total + set.size, 0); },
	};
}

function fixture(t, { text = "", mode = "source", mobile = false, layoutReady = true } = {}) {
	const previousWindow = globalThis.window;
	const timers = new Map(); let nextTimer = 0, ready;
	globalThis.window = {
		setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
		clearTimeout(id) { timers.delete(id); },
	};
	Platform.isMobile = mobile;
	const item = { text: "", hidden: false, removed: false,
		addClass(value) { this.cls = value; }, hide() { this.hidden = true; }, show() { this.hidden = false; },
		setText(value) { this.text = value; }, remove() { this.removed = true; },
	};
	const view = new MarkdownView("Note.md", text); view.mode = mode;
	const workspace = Object.assign(events(), {
		active: view,
		getActiveViewOfType(type) { return this.active instanceof type ? this.active : null; },
		onLayoutReady(callback) { ready = callback; if (layoutReady) callback(); },
	});
	const vault = Object.assign(events(), {
		reads: 0, text,
		async cachedRead() { this.reads++; return this.text; },
	});
	const plugin = { app: { workspace, vault }, settings: { enabled: false },
		addStatusBarItem() { return item; },
	};
	const status = new ThreadCountStatus(plugin); status.load();
	t.after(() => { status.unload(); Platform.isMobile = false; globalThis.window = previousWindow; });
	return {
		view, workspace, vault, item, status, timers, ready: () => ready?.(),
		async flush() {
			const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback());
			await new Promise(resolve => setImmediate(resolve));
		},
		edit(text) { view.text = text; workspace.emit("editor-change", {}, view); },
		switchTo(active) { workspace.active = active; workspace.emit("active-leaf-change", {}); },
	};
}

for (const [name, text, expected] of [
	["empty note", "", "0 threads"],
	["one thread with replies", "%% ::A:: root %%\n%% ::B:: reply %%", "1 thread"],
	["separate threads", "%% one %%\n\n%% two %% text %% three %%", "3 threads"],
	["code literals", "`%% inline %%`\n\n```\n%% fenced %%\n```", "0 threads"],
	["empty placeholder", "%% ::A::  %%", "1 thread"],
	["table and callout threads", "| A | B |\n| --- | --- |\n| Cell %% table %% | Other |\n\n> [!note]\n> Text %% callout %%", "2 threads"],
]) {
	test(`counts ${name} with review cards disabled`, async t => {
		const f = fixture(t, { text }); await f.flush();
		assert.equal(f.item.text, expected); assert.equal(f.item.hidden, false);
		assert.equal(f.item.tooltip, "Review threads in Note.md"); assert.equal(f.vault.reads, 0);
	});
}

test("unsaved edits update replies, split/merged threads, deletion, resolution and undo", async t => {
	const f = fixture(t, { text: "%% root %%" }); await f.flush();
	for (const [text, expected] of [
		["%% root %%\n%% reply %%", "1 thread"],
		["%% root %%\n\n%% reply %%", "2 threads"],
		["%% root %% %% reply %%", "1 thread"],
		["%% root %%", "1 thread"],
		["", "0 threads"],
		["%% root %%", "1 thread"],
	]) {
		f.edit(text); await f.flush(); assert.equal(f.item.text, expected);
	}
	assert.equal(f.vault.text, "%% root %%"); assert.equal(f.vault.reads, 0);
});

test("table-cell events count the full owning note and coalesce rapid changes", async t => {
	const f = fixture(t, { text: "%% outside table %%\n\n| A |\n| --- |\n| %% inside table %% |" });
	await f.flush(); const before = f.view.reads;
	for (let i = 0; i < 20; i++) f.workspace.emit("editor-change", { getValue: () => "%% cell only %%" }, { file: f.view.file });
	assert.equal(f.timers.size, 1); await f.flush();
	assert.equal(f.view.reads, before + 1); assert.equal(f.item.text, "2 threads");
});

test("active note switches clear the old count and non-Markdown views hide it", async t => {
	const f = fixture(t, { text: "%% one %%" }); await f.flush();
	const other = new MarkdownView("Other.md", "");
	f.switchTo(other); assert.equal(f.item.hidden, true); await f.flush();
	assert.equal(f.item.text, "0 threads"); assert.equal(f.item.tooltip, "Review threads in Other.md");
	f.switchTo({ file: { path: "Board.canvas" } }); await f.flush(); assert.equal(f.item.hidden, true);
	f.switchTo(null); await f.flush(); assert.equal(f.item.hidden, true);
});

test("inactive notes do not affect the active count", async t => {
	const f = fixture(t, { text: "%% active %%" }); await f.flush();
	const other = new MarkdownView("Other.md", "%% one %%\n\n%% two %%");
	f.workspace.emit("editor-change", {}, other); f.vault.emit("modify", other.file);
	assert.equal(f.timers.size, 0); assert.equal(f.item.text, "1 thread");
});

test("Reading view uses the vault and refreshes after external changes and mode switches", async t => {
	const f = fixture(t, { mode: "preview", text: "%% saved %%" }); await f.flush();
	assert.equal(f.item.text, "1 thread"); assert.equal(f.view.reads, 0);
	f.vault.text = "%% one %%\n\n%% two %%"; f.vault.emit("modify", f.view.file); await f.flush();
	assert.equal(f.item.text, "2 threads");
	f.view.mode = "source"; f.view.text = ""; f.workspace.emit("layout-change"); await f.flush();
	assert.equal(f.item.text, "0 threads");
	f.view.mode = "preview"; f.workspace.emit("layout-change"); await f.flush();
	assert.equal(f.item.text, "2 threads");
});

test("late Reading-view reads cannot replace the count after switching notes", async t => {
	const f = fixture(t, { mode: "preview" }); let resolve;
	f.vault.cachedRead = () => new Promise(done => { resolve = done; }); await f.flush();
	f.switchTo(new MarkdownView("Other.md", "%% current %%")); await f.flush();
	resolve("%% obsolete %%\n\n%% obsolete too %%"); await f.flush();
	assert.equal(f.item.text, "1 thread"); assert.equal(f.item.tooltip, "Review threads in Other.md");
});

test("out-of-order reads of the same note cannot restore an obsolete count", async t => {
	const f = fixture(t, { mode: "preview" }); const reads = [];
	f.vault.cachedRead = () => new Promise(resolve => reads.push(resolve)); await f.flush();
	f.vault.emit("modify", f.view.file); await f.flush();
	reads[1]("%% latest %%"); await f.flush();
	reads[0]("%% old %%\n\n%% old too %%"); await f.flush();
	assert.equal(f.item.text, "1 thread");
});

test("rename updates the tooltip and deletion hides the count", async t => {
	const f = fixture(t, { text: "%% root %%" }); await f.flush();
	f.view.file.path = "Renamed.md"; f.vault.emit("rename", f.view.file, "Note.md"); await f.flush();
	assert.equal(f.item.tooltip, "Review threads in Renamed.md");
	const removed = f.view.file; f.view.file = null; f.vault.emit("delete", removed); f.workspace.emit("file-open", null); await f.flush();
	assert.equal(f.item.hidden, true);
});

test("failed reads hide the count instead of displaying a false zero", async t => {
	const f = fixture(t, { mode: "preview", text: "%% one %%" }); await f.flush();
	const previousError = console.error; const errors = [];
	console.error = (...args) => errors.push(args); t.after(() => { console.error = previousError; });
	f.vault.cachedRead = async () => { throw new Error("Unavailable"); };
	f.vault.emit("modify", f.view.file); await f.flush();
	assert.equal(f.item.hidden, true); assert.equal(errors.length, 1);
});

test("unload removes listeners and the item, cancels timers, and ignores late layout readiness", async t => {
	const f = fixture(t, { layoutReady: false });
	f.ready(); assert.equal(f.timers.size, 1); assert.ok(f.workspace.total());
	f.status.unload(); f.ready();
	assert.equal(f.timers.size, 0); assert.equal(f.workspace.total(), 0); assert.equal(f.vault.total(), 0);
	assert.equal(f.item.removed, true);
});

test("unload ignores in-flight Reading-view results", async t => {
	const f = fixture(t, { mode: "preview" }); let resolve;
	f.vault.cachedRead = () => new Promise(done => { resolve = done; }); await f.flush();
	f.status.unload(); resolve("%% late %%"); await f.flush();
	assert.equal(f.item.text, ""); assert.equal(f.item.hidden, true);
});

test("mobile does not create a status item or register refresh listeners", async t => {
	const f = fixture(t, { mobile: true }); await f.flush();
	assert.equal(f.item.cls, undefined); assert.equal(f.workspace.total(), 0); assert.equal(f.vault.total(), 0);
	assert.equal(f.timers.size, 0); assert.equal(f.view.reads, 0);
});
