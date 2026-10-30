import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { externalModules } from "../scripts/build-externals.mjs";

test("production externals preserve host modules, bare built-ins, subpaths and node-prefixed imports", async () => {
	const imports = ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@lezer/common", "fs", "fs/promises", "node:fs", "node:fs/promises", "node:sqlite"];
	const result = await build({
		stdin: { contents: imports.map((name, i) => `export {default as module${i}} from ${JSON.stringify(name)};`).join("\n") },
		bundle: true, format: "cjs", platform: "browser", write: false, metafile: true, external: externalModules,
	});
	const output = Object.values(result.metafile.outputs)[0];
	assert.deepEqual(output.imports.map(({ path }) => path).sort(), [...imports].sort());
	assert.ok(output.imports.every(({ external }) => external));
	assert.deepEqual(Object.keys(result.metafile.inputs), ["<stdin>"]);
});
