import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
	stdin: { contents: `
		export { MentionClient } from './src/mention-client.ts';
		export { buildCard } from './src/card.ts';
		export { DraftStore } from './src/drafts.ts';
		export { parseComments } from './src/parser.ts';
		export { inlineFormat } from './src/mention-format.ts';
		export { Component } from 'obsidian';
	`, resolveDir: process.cwd() },
	bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
		builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `
			export class Component {
				cleanup = []; children = [];
				load() { this.onload?.(); }
				unload() { this.onunload?.(); for (const child of this.children) child.unload(); for (const fn of this.cleanup.splice(0)) fn(); }
				register(fn) { this.cleanup.push(fn); }
				registerEvent(ref) { this.register(() => ref.off()); }
				registerDomEvent(el, event, fn) { el.addEventListener(event, fn); this.register(() => el.removeEventListener(event, fn)); }
				addChild(child) { this.children.push(child); child.load(); return child; }
			}
			export class Scope { register() {} }
			export class MarkdownView {} export class TFile {} export class Notice {}
			export function setIcon() {}
		` }));
	} }],
});
const { MentionClient, buildCard, DraftStore, parseComments, inlineFormat, Component } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const note = `Prose
%% ::Alice:: @teddy cancelled request <!-- aio-comment:cancelled --> %%
%% ::Alice:: @teddy failed request <!-- aio-comment:failed --> %%
%% ::Alice:: @teddy later request <!-- aio-comment:later --> %%
%% ::teddy:: Successful response <!-- aio-reply:job-later --> %%`;
const job = (commentId, state, detail) => ({ request: { id: `job-${commentId}`, commentId }, tag: "teddy", state, detail });

function fixture(saved = [job("cancelled", "cancelled", "Cancelled. Actions already performed are not rolled back."), job("failed", "failed", "Could not publish"), job("later", "completed")]) {
	const dom = new JSDOM(""), { document, HTMLElement } = dom.window;
	const create = (parent, tag, options = {}) => {
		const el = document.createElement(tag);
		if (options.cls) el.className = options.cls;
		if (options.text) el.textContent = options.text;
		for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
		parent?.appendChild(el); return el;
	};
	Object.assign(HTMLElement.prototype, {
		createDiv(options) { return create(this, "div", options); },
		createSpan(options) { return create(this, "span", options); },
		createEl(tag, options) { return create(this, tag, options); },
		addClass(cls) { this.classList.add(cls); }, removeClass(cls) { this.classList.remove(cls); },
		empty() { this.replaceChildren(); }, setText(text) { this.textContent = text; },
		setCssProps(props) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
	});
	globalThis.createDiv = options => create(null, "div", options);
	globalThis.ResizeObserver = class { observe() {} disconnect() {} };
	const events = new Map(), subscribers = new Set(), retried = [], cancelled = [];
	const on = (name, fn) => {
		const set = events.get(name) ?? new Set(); events.set(name, set); set.add(fn);
		return { off: () => set.delete(fn) };
	};
	const emit = () => { for (const fn of subscribers) fn(); };
	const bridge = { version: 2, tag: "teddy", attach: () => () => {}, jobs: (_source, path) => path === "Note.md" ? saved : [],
		subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }, async submit() {},
		async retry(id) { retried.push(id); const found = saved.find(j => j.request.id === id); found.state = "queued"; emit(); },
		cancel(id) { cancelled.push(id); saved.find(j => j.request.id === id).state = "cancelled"; emit(); },
	};
	on("ai-overview:discover-v2", callback => callback(bridge));
	const app = { scope: {}, keymap: { pushScope() {}, popScope() {} },
		workspace: { on, trigger(name, ...args) { for (const fn of events.get(name) ?? []) fn(...args); }, iterateAllLeaves() {} },
		vault: { on },
	};
	const client = new MentionClient({ app }, "inline-review-comment", inlineFormat, () => true); client.load();
	const drafts = new DraftStore(), owners = [];
	let layouts = 0;
	const render = (text = note, path = "Note.md") => {
		const owner = new Component(); owners.push(owner);
		const card = buildCard(parseComments(text), {
			app, drafts, sourcePath: path, onEscape() {}, onReply: async () => true, onPost: async () => true, onEdit: async () => true, onDelete() {}, onResolve() {},
			renderBody(el, text) { el.setText(text); },
			bindMessageStatus(message, comment, component) {
				client.bind(message, path, [comment.id], component, () => layouts++, undefined, { states: ["cancelled", "failed"] });
			},
			bindStatus(card, thread, component, replyBox) {
				const ids = thread.map(c => c.id ?? null);
				client.bind(card, path, ids, component, () => layouts++, replyBox, { states: ["queued", "running", "applying"] });
				client.bindComposer(replyBox, path, ids, component);
			},
		}, owner);
		document.body.appendChild(card); return { card, owner };
	};
	return { client, bridge, saved, retried, cancelled, emit, render, document, layouts: () => layouts,
		close() { for (const owner of owners) owner.unload(); client.unload(); dom.window.close(); } };
}

test("cancelled and failed outcomes stay inside their initiating message after success, redraw and restored history", () => {
	const f = fixture();
	const check = card => {
		assert.equal(card.querySelectorAll(".aio-mention-status").length, 2);
		const cancelled = card.querySelector('[data-irc-comment-id="cancelled"]');
		assert.match(cancelled.querySelector(".aio-mention-status").textContent, /Cancelled/);
		assert.equal(cancelled.lastElementChild.className, "aio-mention-status");
		assert.match(card.querySelector('[data-irc-comment-id="failed"] .aio-mention-status').textContent, /Could not publish/);
		assert.equal(card.querySelector('[data-irc-comment-id="later"] .aio-mention-status'), null);
		const response = [...card.querySelectorAll(".irc-message")].at(-1);
		assert.match(response.textContent, /Successful response/);
		assert.equal(response.querySelector(".aio-mention-status"), null);
		assert.equal([...card.children].filter(el => el.classList.contains("aio-mention-status")).length, 0);
	};
	const first = f.render(); check(first.card);
	first.owner.unload(); first.card.remove(); check(f.render().card);
	const snapshot = JSON.parse(JSON.stringify(f.saved)); f.close();
	const restored = fixture(snapshot); check(restored.render().card); restored.close();
});

test("multiple cancellations, unrelated threads and missing origins never fall back to another message", () => {
	const f = fixture([job("cancelled", "cancelled", "First cancellation"), job("failed", "cancelled", "Second cancellation"), job("gone", "failed", "Deleted request")]);
	const { card } = f.render();
	assert.equal(card.querySelectorAll(".aio-mention-status").length, 2);
	assert.match(card.querySelector('[data-irc-comment-id="cancelled"]').textContent, /First cancellation/);
	assert.match(card.querySelector('[data-irc-comment-id="failed"]').textContent, /Second cancellation/);
	assert.doesNotMatch(card.textContent, /Deleted request/);
	assert.equal(f.render(note, "Other.md").card.querySelector(".aio-mention-status"), null);
	const removed = note.replace(/^%%.*aio-comment:cancelled.*\n/m, "");
	const redrawn = f.render(removed).card;
	assert.equal(redrawn.querySelectorAll(".aio-mention-status").length, 1);
	assert.doesNotMatch(redrawn.textContent, /First cancellation/); f.close();
});

test("Retry follows its request through progress, repeat failure and completion without disturbing the reply draft", async () => {
	const f = fixture(), { card } = f.render();
	const message = card.querySelector('[data-irc-comment-id="failed"]'), reply = card.querySelector(".irc-reply"), input = reply.querySelector("textarea");
	input.value = "Draft to preserve"; input.dispatchEvent(new f.document.defaultView.Event("input")); input.focus();
	message.querySelector(".aio-mention-job button").click(); await Promise.resolve();
	assert.deepEqual(f.retried, ["job-failed"]);
	assert.equal(message.querySelector(".aio-mention-status"), null);
	assert.equal(card.querySelector(".aio-mention-status").closest(".irc-message").dataset.ircCommentId, "cancelled");
	assert.ok([...card.children].some(el => el.className === "aio-mention-status" && /queued/.test(el.textContent)));
	assert.equal(input.disabled, true);
	const failed = f.saved.find(j => j.request.commentId === "failed");
	failed.state = "running"; failed.detail = "Reading notes"; f.emit();
	const dots = card.querySelector(".aio-mention-typing");
	failed.detail = "Checking results"; f.emit();
	assert.equal(card.querySelector(".aio-mention-typing"), dots);
	assert.equal(card.querySelector(".aio-mention-step").textContent, "Checking results");
	assert.equal(card.querySelectorAll(".aio-mention-status").length, 2);
	failed.state = "failed"; failed.error = "Retry failed"; f.emit();
	assert.match(message.querySelector(".aio-mention-status").textContent, /Retry failed/);
	assert.equal(input.disabled, false); assert.equal(input.value, "Draft to preserve");
	assert.equal(f.document.activeElement, input);
	message.querySelector(".aio-mention-job button").click(); await Promise.resolve();
	failed.state = "completed"; f.emit();
	assert.equal(message.querySelector(".aio-mention-status"), null);
	assert.equal(input.disabled, false); assert.equal(input.value, "Draft to preserve");
	assert.deepEqual(f.retried, ["job-failed", "job-failed"]); f.close();
});

test("terminal text updates, disconnect and teardown remove only owned notices and listeners", () => {
	const f = fixture(), { card, owner } = f.render();
	const failed = f.saved.find(j => j.state === "failed"), message = card.querySelector('[data-irc-comment-id="failed"]');
	const layouts = f.layouts(); failed.detail = "Updated failure detail"; f.emit();
	assert.match(message.querySelector(".aio-mention-status").textContent, /Updated failure detail/);
	assert.ok(f.layouts() > layouts);
	failed.error = "Specific error"; f.emit();
	assert.match(message.querySelector(".aio-mention-status").textContent, /Specific error/);
	f.bridge.tag = ""; f.emit(); assert.equal(card.querySelector(".aio-mention-status"), null);
	f.bridge.tag = "teddy"; f.emit(); assert.equal(card.querySelectorAll(".aio-mention-status").length, 2);
	owner.unload(); f.emit(); assert.equal(card.querySelector(".aio-mention-status"), null); f.close();
});
