import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const bundle = await build({
	entryPoints: ["src/card-layer.ts"], bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "obsidian-host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
		builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export function setIcon() {} export class Component { load() {} unload() {} } export class Notice {} export class Scope {}" }));
	} }],
});
const { CardLayer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

for (const position of ["static", "relative", "absolute"]) {
	test(`layer teardown restores a ${position} container`, () => {
		const classes = new Set(["existing-class"]);
		let removed = false;
		const parent = {
			style: new JSDOM("").window.document.createElement("div").style,
			classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
			win: { getComputedStyle: () => ({ position }) },
			createDiv: () => ({ style: { setProperty() {} }, remove() { removed = true; } }),
		};
		const layer = new CardLayer(parent, 240);
		assert.equal(classes.has("irc-positioned-container"), position === "static");
		layer.destroy();
		assert.deepEqual([...classes], ["existing-class"]);
		assert.equal(removed, true);
	});
}

for (const previous of ["", "300px"]) test(`card widths update the shared gutter and restore its previous value (${previous || "unset"})`, () => {
	const dom = new JSDOM(""), parent = dom.window.document.body;
	parent.win = dom.window;
	parent.createDiv = ({ cls }) => { const el = parent.appendChild(dom.window.document.createElement("div")); el.className = cls; return el; };
	if (previous) parent.style.setProperty("--irc-card-width", previous, "important");
	const layer = new CardLayer(parent, 180);
	assert.equal(parent.style.getPropertyValue("--irc-card-width"), "180px");
	layer.setWidth(360);
	assert.equal(parent.style.getPropertyValue("--irc-card-width"), "360px");
	layer.destroy();
	assert.equal(parent.style.getPropertyValue("--irc-card-width"), previous);
	assert.equal(parent.style.getPropertyPriority("--irc-card-width"), previous ? "important" : "");
	dom.window.close();
});

test("layer teardown leaves a width replaced by another owner intact", () => {
	const dom = new JSDOM(""), parent = dom.window.document.body;
	parent.win = dom.window;
	parent.createDiv = () => parent.appendChild(dom.window.document.createElement("div"));
	const layer = new CardLayer(parent, 240);
	parent.style.setProperty("--irc-card-width", "500px");
	layer.destroy();
	assert.equal(parent.style.getPropertyValue("--irc-card-width"), "500px");
	dom.window.close();
});
