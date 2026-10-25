import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { documentFixture, key } from "./helpers/dom.mjs";
globalThis.window = { setTimeout: (fn) => fn() };

const bundle = await build({ stdin: { contents: "export * from './src/author-prompt.ts'; export { cleanAuthorName } from './src/author.ts'; export { commentMarkdown } from './src/comment-edit.ts'; export { parseComments } from './src/parser.ts'; export { Modal } from 'obsidian';", resolveDir: process.cwd() },
	bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
		builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `
 export const Platform = { isDesktop: false };
 export class Modal {
	static last = null;
	constructor() { this.contentEl = Modal.body.createDiv(); this.scope = { keys: [], register(modifiers, key) { this.keys.push(key); } }; Modal.last = this; }
	setTitle() {} open() {} close() { this.closes = (this.closes ?? 0) + 1; this.onClose(); }
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
` }));
	} }],
});
const { promptForAuthor, cleanAuthorName, commentMarkdown, parseComments, Modal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function open(suggestion) {
	Modal.body = documentFixture().body;
	const questions = new AbortController();
	const result = promptForAuthor({}, suggestion, questions.signal);
	const [input] = Modal.last.contentEl.querySelectorAll("input");
	const [anonymous, save] = Modal.last.contentEl.querySelectorAll("button");
	const type = (value) => { input.value = value; input.dispatchEvent(new Event("input")); };
	return { result, input, anonymous, save, type, questions };
}

test("Enter in the name field saves the typed name", async () => {
	const { result, input, type } = open("Alice");
	type("  Bob  ");
	const event = key(input, { key: "Enter" });
	assert.equal(event.defaultPrevented, true);
	assert.equal(await result, "Bob");
});

// A keyboard user tabs to the button: Enter must stay its native click.
test("Enter on a focused button is left to that button", async () => {
	const { result, anonymous } = open("Alice");
	assert.deepEqual(Modal.last.scope.keys, [], "a modal-wide binding would swallow the button's Enter");
	const event = key(anonymous, { key: "Enter" });
	assert.equal(event.defaultPrevented, false);
	anonymous.click();
	assert.equal(await result, "");
});

test("Enter confirming an IME composition does not close the dialog", async () => {
	const { result, input, save, type } = open("");
	type("アリス");
	assert.equal(key(input, { key: "Enter", isComposing: true }).defaultPrevented, false);
	save.click();
	assert.equal(await result, "アリス");
});

test("aborting closes the dialog and reports no choice", async () => {
	const { result, type, questions } = open("Alice");
	type("Bob");
	questions.abort();
	assert.equal(await result, null);
	assert.equal(Modal.last.closes, 1);
});

test("aborting after a choice leaves the closed dialog alone", async () => {
	const { result, save, questions } = open("Alice");
	save.click();
	questions.abort();
	assert.equal(await result, "Alice");
	assert.equal(Modal.last.closes, 1);
});

// git allows "Ops: Alice" as user.name, which the ::author:: prefix cannot hold.
test("the prefill and the saved name are safe for the comment format", async () => {
	const { result, input, save, type } = open("Ops: Alice");
	assert.equal(input.value, "Ops Alice");
	type("Team: 100%% Bob");
	save.click();
	assert.equal(await result, "Team 100 Bob");
});

test("a cleaned name round-trips through a comment", () => {
	for (const name of ["Ops: Alice", "a%%b", "a%:%b", "Ada\nLovelace", "José Müller", "O'Brien <ops>", "Alice ::"]) {
		const clean = cleanAuthorName(name);
		const [comment, ...rest] = parseComments(`Text ${commentMarkdown(clean, "Body")} after`);
		assert.equal(rest.length, 0, name);
		assert.equal(comment.author, clean, name);
		assert.equal(comment.body, "Body", name);
	}
});
