import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { documentFixture } from "./helpers/dom.mjs";
globalThis.window = { setTimeout: (fn) => fn() };

const bundle = await build({ stdin: { contents: "export { default } from './src/main.ts'; export { Modal } from 'obsidian';", resolveDir: process.cwd() },
	bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
		builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ resolveDir: process.cwd(), contents: `
 import { StateField } from '@codemirror/state';
 export const editorInfoField = StateField.define({ create: () => null, update: (v) => v });
 export const editorLivePreviewField = StateField.define({ create: () => false, update: (v) => v });
 export const Platform = { isDesktop: false };
 export class Component { load() {} unload() {} addChild(child) { return child; } register() {} registerEvent() {} registerDomEvent() {} }
 export class Plugin extends Component {
	commands = {}; tabs = [];
	constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; }
	async loadData() { return this.app.data; }
	async saveData(data) { this.app.saved.push(data); }
	registerEditorExtension() {} registerMarkdownPostProcessor() {}
	addSettingTab(tab) { this.tabs.push(tab); }
	addCommand(command) { this.commands[command.id] = command; }
 }
 export class PluginSettingTab {
	getControlValue(key) { return "super:" + key; }
	setControlValue(key, value) { this.superValue = [key, value]; }
 }
 export class Modal {
	static opened = [];
	closed = false;
	constructor() { this.contentEl = Modal.body.createDiv(); this.scope = { register() {} }; Modal.opened.push(this); }
	setTitle() {} open() {}
	close() { this.closed = true; this.onClose(); }
 }
 export class Setting {
	constructor(el) { this.el = el; }
	setName() { return this; }
	addText(build) {
		const inputEl = Object.assign(this.el.createEl("input"), { select() {} });
		build({ inputEl, setPlaceholder() { return this; }, setValue(value) { inputEl.value = value; return this; },
			onChange(fn) { inputEl.addEventListener("input", () => fn(inputEl.value)); return this; } });
		return this;
	}
	addButton(build) {
		const buttonEl = this.el.createEl("button");
		build({ setButtonText() { return this; }, setCta() { return this; }, onClick(fn) { buttonEl.addEventListener("click", fn); return this; } });
		return this;
	}
 }
 export class Notice {} export class Scope {} export class TFile {} export class MarkdownView {} export class MarkdownRenderChild {}
 export const MarkdownRenderer = {}; export function setIcon() {} export function setTooltip() {}
` }));
	} }],
});
const { default: InlineReviewCommentPlugin, Modal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Obsidian's side of a vault on one device: what survives a plugin reload. */
function device({ data = {}, git = async () => { throw new Error("no repository"); } } = {}) {
	const local = new Map(), bodyClasses = [];
	globalThis.document = { body: { classList: { toggle: (name, on) => bodyClasses.push([name, on]), remove() {} } } };
	Modal.body = documentFixture().body;
	Modal.opened.length = 0;
	return {
		data, saved: [], bodyClasses,
		loadLocalStorage: (key) => local.has(key) ? JSON.parse(local.get(key)) : null,
		saveLocalStorage: (key, value) => value ? local.set(key, JSON.stringify(value)) : local.delete(key),
		vault: { adapter: { read: git } },
		workspace: { on: () => ({}), trigger() {}, onLayoutReady: (fn) => fn(), iterateAllLeaves() {} },
	};
}

async function load(app) {
	const plugin = new InlineReviewCommentPlugin(app, { id: "irc" });
	await plugin.onload();
	return plugin;
}

function editor() {
	const inserted = [];
	return { inserted, getSelection: () => "", getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => 0, offsetToPos: () => ({ line: 0, ch: 0 }), setCursor() {}, focus() {},
		replaceRange(text) { inserted.push(text); } };
}

function command(plugin) {
	const target = editor();
	plugin.commands["insert-comment"].editorCallback(target);
	return target;
}

function dialog() {
	const modal = Modal.opened.at(-1);
	const [input] = modal.contentEl.querySelectorAll("input");
	const [anonymous, save] = modal.contentEl.querySelectorAll("button");
	return { modal, input, anonymous, save };
}

test("a named choice is stored, used for the comment, and not asked again after a reload", async () => {
	const app = device(), plugin = await load(app);
	const first = command(plugin);
	await tick();
	dialog().input.value = "Bob";
	dialog().input.dispatchEvent(new Event("input"));
	dialog().save.click();
	await tick();
	assert.deepEqual(first.inserted, ["%% ::Bob::  %%"]);
	assert.equal(plugin.author.get(), "Bob");
	assert.equal(JSON.stringify(app.saved).includes("Bob"), false, "the name stays out of data.json");

	const reloaded = await load(app), second = command(reloaded);
	await tick();
	assert.equal(Modal.opened.length, 1);
	assert.deepEqual(second.inserted, ["%% ::Bob::  %%"]);
});

test("an anonymous choice is stored and not asked again after a reload", async () => {
	const app = device(), plugin = await load(app);
	const first = command(plugin);
	await tick();
	dialog().anonymous.click();
	await tick();
	assert.deepEqual(first.inserted, ["%%  %%"]);
	assert.equal(plugin.author.get(), "");

	const reloaded = await load(app), second = command(reloaded);
	await tick();
	assert.equal(Modal.opened.length, 1);
	assert.deepEqual(second.inserted, ["%%  %%"]);
});

test("dismissing stores nothing, writes nothing and asks again next time", async () => {
	const app = device(), plugin = await load(app);
	const target = command(plugin);
	await tick();
	dialog().modal.close();
	await tick();
	assert.deepEqual(target.inserted, []);
	assert.equal(plugin.author.get(), null);
	command(plugin);
	await tick();
	assert.equal(Modal.opened.length, 2);
});

test("concurrent comments share one dialog", async () => {
	const plugin = await load(device());
	const answers = [plugin.resolveAuthor(), plugin.resolveAuthor()];
	await tick();
	assert.equal(Modal.opened.length, 1);
	dialog().save.click();
	assert.deepEqual(await Promise.all(answers), ["", ""]);
});

test("the prefill falls back to the old shared setting", async () => {
	const plugin = await load(device({ data: { username: "Old Name" } }));
	void plugin.resolveAuthor();
	await tick();
	assert.equal(dialog().input.value, "Old Name");
});

test("the prefill uses the vault's git name first", async () => {
	const plugin = await load(device({ data: { username: "Old Name" }, git: async () => "[user]\n\tname = Ada\n" }));
	void plugin.resolveAuthor();
	await tick();
	assert.equal(dialog().input.value, "Ada");
});

// The plugin is disabled while the git config read is still running.
test("unloading before the dialog opens cancels the comment", async () => {
	let finishRead;
	const app = device({ git: () => new Promise((resolve) => { finishRead = resolve; }) }), plugin = await load(app);
	const target = command(plugin), author = plugin.resolveAuthor();
	await tick();
	plugin.onunload();
	finishRead("[user]\n\tname = Ada\n");
	assert.equal(await author, null);
	await tick();
	assert.equal(Modal.opened.length, 0);
	assert.deepEqual(target.inserted, []);
	assert.equal(plugin.author.get(), null);
});

test("unloading with the dialog open closes it and cancels the comment", async () => {
	const plugin = await load(device());
	const target = command(plugin), author = plugin.resolveAuthor();
	await tick();
	const { modal } = dialog();
	plugin.onunload();
	assert.equal(modal.closed, true);
	assert.equal(await author, null);
	await tick();
	assert.deepEqual(target.inserted, []);
	assert.equal(plugin.author.get(), null);
});

test("the settings control reads and writes the device-local author", async () => {
	const app = device(), plugin = await load(app);
	const [tab] = plugin.tabs;
	assert.equal(tab.getControlValue("author"), "");
	tab.setControlValue("author", "Carol");
	assert.equal(tab.getControlValue("author"), "Carol");
	assert.equal(tab.superValue, undefined);

	const reloaded = await load(app), target = command(reloaded);
	await tick();
	assert.equal(Modal.opened.length, 0);
	assert.deepEqual(target.inserted, ["%% ::Carol::  %%"]);

	tab.setControlValue("author", "");
	assert.equal(plugin.author.get(), "", "a blank field means anonymous, not unset");
	assert.equal(tab.getControlValue("cardWidth"), "super:cardWidth");
	tab.setControlValue("cardWidth", 300);
	assert.deepEqual(tab.superValue, ["cardWidth", 300]);
});

// Another device changed data.json and git or Sync delivered it.
test("external data.json changes are adopted, refresh the views and leave the author alone", async () => {
	const app = device({ data: { cardWidth: 240, overrideToggleComment: false } }), plugin = await load(app);
	const toggle = {};
	app.commands = { commands: { "editor:toggle-comments": toggle } };
	plugin.author.set("Bob");
	const version = plugin.settingsVersion;
	let redraws = 0;
	plugin.editorRenderers.add({ redraw: () => redraws++, destroy() {} });
	app.bodyClasses.length = 0;

	app.data = { cardWidth: 300, enabled: false, overrideToggleComment: true, username: "Synced" };
	await plugin.onExternalSettingsChange();

	assert.equal(plugin.settings.cardWidth, 300);
	assert.equal(plugin.settingsVersion, version + 1);
	assert.equal(redraws, 1);
	assert.deepEqual(app.bodyClasses, [["irc-active", false]]);
	assert.equal(typeof toggle.editorCallback, "function", "the toggle override follows the new setting");
	assert.equal(plugin.author.get(), "Bob");

	await plugin.saveSettings();
	assert.equal(app.saved.at(-1).cardWidth, 300, "the next save keeps the received values");
	assert.equal(app.saved.at(-1).enabled, false);
	assert.equal("username" in app.saved.at(-1), false);
});
