import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { Gravatar } from "../src/gravatar.ts";

const email = "reviewer@example.invalid";
const urlFor = (address) => `https://gravatar.com/avatar/${createHash("sha256").update(address).digest("hex")}?s=64&d=404`;
globalThis.window = undefined;
globalThis.Image = undefined;

function avatar() {
	const classes = new Set(), images = new Set();
	return {
		classes, images,
		classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
		createEl() {
			const image = new EventTarget();
			image.remove = () => images.delete(image);
			images.add(image);
			return image;
		},
	};
}

function fixture(t, { stored = null, fetch = () => new Response("photo"), decode = async () => {} } = {}) {
	const requests = [], deadlines = new Map();
	let next = 0, author = "Reviewer";
	t.mock.method(globalThis, "fetch", (url, options) => {
		requests.push({ url, ...options });
		return fetch(url, options);
	});
	t.mock.property(globalThis, "window", {
		setTimeout(fn, ms) {
			const id = ++next;
			deadlines.set(id, { fn, ms });
			return id;
		},
		clearTimeout(id) { deadlines.delete(id); },
	});
	t.mock.property(globalThis, "Image", class { decode = decode; });
	const storage = {
		loadLocalStorage: () => stored,
		saveLocalStorage(key, value) {
			assert.equal(key, "plugin:gravatar-email");
			stored = value;
		},
	};
	const gravatar = new Gravatar(storage, "plugin:gravatar-email", () => author);
	t.after(() => gravatar.destroy());
	return { gravatar, requests, deadlines, stored: () => stored, changeAuthor(name) { author = name; gravatar.refresh(); } };
}

async function until(check) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await pause(2);
	}
	assert.ok(check(), "expected asynchronous lookup to settle");
}

test("blank settings and other authors do not make requests", async (t) => {
	const { gravatar, requests, deadlines } = fixture(t);
	gravatar.bind(avatar(), "Reviewer")();
	gravatar.bind(avatar(), "reviewer");
	gravatar.bind(avatar(), null);
	gravatar.setEmail(email);
	assert.equal(deadlines.size, 0);
	assert.deepEqual(requests, []);
});

test("matching avatars share a hashed lookup, then switch in place", async (t) => {
	const { gravatar, requests, stored, changeAuthor } = fixture(t);
	const first = avatar(), second = avatar(), other = avatar();
	const unbind = gravatar.bind(first, "Reviewer");
	gravatar.bind(second, "Reviewer");
	gravatar.bind(other, "Another author");
	gravatar.setEmail("  Reviewer@Example.Invalid  ");
	assert.equal(stored(), email);
	assert.equal(first.images.size, 0);
	await until(() => first.images.size === 1);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, urlFor(email));
	assert.equal(requests[0].credentials, "omit");
	assert.equal(requests[0].referrerPolicy, "no-referrer");
	const [photo] = first.images;
	assert.equal(photo.src, [...second.images][0].src);
	assert.equal(first.classes.has("has-gravatar"), false);
	photo.dispatchEvent(new Event("load"));
	assert.equal(first.classes.has("has-gravatar"), true);
	assert.equal(other.images.size, 0);
	unbind();
	assert.equal(first.images.size, 0);
	changeAuthor("Another author");
	assert.equal(second.images.size, 0);
	assert.equal(other.images.size, 1);
	gravatar.setEmail("");
	assert.equal(stored(), null);
	assert.equal(other.images.size, 0);
});

for (const [failure, fetch, decode] of [
	["missing image", () => new Response(null, { status: 404 })],
	["offline", () => { throw new TypeError("offline"); }],
	["invalid image", () => new Response("bad image"), async () => { throw new Error("cannot decode"); }],
	["timeout", (_url, { signal }) => new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	})],
]) {
	test(`keeps generated avatars after ${failure} and retries on a later render`, async (t) => {
		const { gravatar, requests, deadlines } = fixture(t, { stored: email, fetch, decode });
		let time = Date.now();
		t.mock.method(Date, "now", () => time);
		const first = avatar();
		gravatar.bind(first, "Reviewer");
		await until(() => requests.length === 1);
		if (failure === "timeout") {
			const [{ ms, fn }] = deadlines.values();
			assert.equal(ms, 8000);
			fn();
			assert.equal(requests[0].signal.aborted, true);
		}
		await until(() => deadlines.size === 0);
		assert.equal(first.images.size, 0);
		gravatar.bind(avatar(), "Reviewer");
		assert.equal(deadlines.size, 0);
		time += 60_001;
		gravatar.bind(avatar(), "Reviewer");
		await until(() => requests.length === 2);
		if (failure === "timeout") [...deadlines.values()][0].fn();
		await until(() => deadlines.size === 0);
	});
}

test("changing the email aborts the old request and ignores its late result", async (t) => {
	const next = "other@example.invalid";
	let resolveOld;
	const { gravatar, requests, deadlines } = fixture(t, {
		stored: email,
		fetch: (url) => url === urlFor(email) ? new Promise((resolve) => { resolveOld = resolve; }) : new Response("new photo"),
	});
	const first = avatar();
	gravatar.bind(first, "Reviewer");
	await until(() => !!resolveOld);
	gravatar.setEmail(next);
	assert.equal(requests[0].signal.aborted, true);
	await until(() => first.images.size === 1);
	const [photo] = first.images;
	resolveOld(new Response("old photo"));
	await until(() => deadlines.size === 0);
	assert.deepEqual([...first.images], [photo]);
});
