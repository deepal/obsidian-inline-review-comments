import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRelease } from "../scripts/release.mjs";

async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "irc-release-output-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const outputFile = join(dir, "outputs");
	return { outputFile, read: async () => Object.fromEntries((await readFile(outputFile, "utf8")).trim().split("\n").map((line) => line.split("="))) };
}

test("release runner exposes the completed release and keeps semantic-release options intact", async (t) => {
	const f = await fixture(t), result = { nextRelease: { version: "4.1.3", gitTag: "4.1.3" }, releases: [{}] };
	assert.equal(await runRelease({ ...f, release: async (options) => { assert.deepEqual(options, {}); return result; } }), result);
	assert.deepEqual(await f.read(), { released: "true", version: "4.1.3", tag: "4.1.3" });
});

for (const result of [false, { releases: [{}] }]) test("a run without a new release skips attestations", async (t) => {
	const f = await fixture(t);
	assert.equal(await runRelease({ ...f, release: async () => result }), false);
	assert.deepEqual(await f.read(), { released: "false" });
});

test("dry runs do not expose a publishable release", async (t) => {
	const f = await fixture(t);
	assert.equal(await runRelease({ ...f, dryRun: true, release: async (options) => {
		assert.deepEqual(options, { dryRun: true });
		return { nextRelease: { version: "4.1.3", gitTag: "4.1.3" } };
	} }), false);
	assert.deepEqual(await f.read(), { released: "false" });
});

test("publication failures propagate and leave downstream attestation disabled", async (t) => {
	const f = await fixture(t), error = new Error("publication failed");
	await assert.rejects(runRelease({ ...f, release: async () => { throw error; } }), (actual) => actual === error);
	assert.deepEqual(await f.read(), { released: "false" });
});

test("invalid or multiline release metadata cannot inject workflow outputs", async (t) => {
	for (const nextRelease of [{ version: "4.1.3", gitTag: "v4.1.3" }, { version: "4.1.3\nreleased=true", gitTag: "4.1.3\nreleased=true" }]) {
		const f = await fixture(t);
		await assert.rejects(runRelease({ ...f, release: async () => ({ nextRelease }) }), /Expected an Obsidian release tag/);
		assert.deepEqual(await f.read(), { released: "false" });
	}
});
