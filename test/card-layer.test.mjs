import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
	entryPoints: ["src/card-layer.ts"], bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "obsidian-host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
		builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export function setIcon() {}" }));
	} }],
});
const { CardLayer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

for (const position of ["static", "relative", "absolute"]) {
	test(`layer teardown restores a ${position} container`, () => {
		const classes = new Set(["existing-class"]);
		let removed = false;
		const parent = {
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
