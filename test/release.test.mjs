import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";
import releaseConfig from "../release.config.mjs";

const exec = promisify(execFile);
const prepareScript = fileURLToPath(new URL("../scripts/prepare-release.mjs", import.meta.url));

async function releaseFixture(t) {
	const cwd = await mkdtemp(join(tmpdir(), "inline-review-release-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const fixture = {
		"package.json": { name: "plugin", version: "0.1.0", private: true },
		"package-lock.json": {
			version: "0.1.0",
			lockfileVersion: 3,
			packages: {
				"": { name: "plugin", version: "0.1.0" },
				"node_modules/example": { version: "2.3.4" },
			},
		},
		"manifest.json": { id: "plugin", version: "0.1.0", minAppVersion: "1.6.0" },
		"versions.json": { "0.1.0": "1.5.0" },
	};
	await Promise.all(Object.entries(fixture).map(([file, data]) =>
		writeFile(join(cwd, file), JSON.stringify(data) + "\n")
	));
	return { cwd, fixture };
}

test("release preparation synchronizes versions and preserves compatibility history", async (t) => {
	const { cwd } = await releaseFixture(t);
	await exec(process.execPath, [prepareScript, "1.2.3"], { cwd });
	const read = async (file) => JSON.parse(await readFile(join(cwd, file), "utf8"));
	assert.equal((await read("package.json")).version, "1.2.3");
	assert.equal((await read("package.json")).private, true);
	const lock = await read("package-lock.json");
	assert.equal(lock.version, "1.2.3");
	assert.equal(lock.packages[""].version, "1.2.3");
	assert.equal(lock.packages["node_modules/example"].version, "2.3.4");
	assert.deepEqual(await read("manifest.json"), {
		id: "plugin", version: "1.2.3", minAppVersion: "1.6.0",
	});
	assert.deepEqual(await read("versions.json"), { "0.1.0": "1.5.0", "1.2.3": "1.6.0" });
});

test("release preparation rejects unsupported versions before writing files", async (t) => {
	const { cwd, fixture } = await releaseFixture(t);
	for (const version of [undefined, "v1.2.3", "1.2", "01.2.3", "1.2.3-beta.1", "1.2.3+build"]) {
		await assert.rejects(
			exec(process.execPath, [prepareScript, ...(version ? [version] : [])], { cwd }),
			/Expected a stable semantic version/
		);
	}
	for (const [file, data] of Object.entries(fixture)) {
		assert.equal(await readFile(join(cwd, file), "utf8"), JSON.stringify(data) + "\n");
	}
});

const analyzerOptions = releaseConfig.plugins.find(([name]) => name === "@semantic-release/commit-analyzer")[1];
const logger = { log() {} };

for (const [message, expected] of [
	["fix: correct comment positioning", "patch"],
	["feat: add a comment filter", "minor"],
	["feat!: change the comment format", "major"],
	["fix(parser)!: change the comment format", "major"],
	["refactor: change the comment format\n\nBREAKING CHANGE: old comments must be migrated", "major"],
	["docs: clarify installation", null],
	["chore(release): 1.2.3 [skip ci]", null],
]) {
	test(`release analysis: ${message.split("\n")[0]}`, async () => {
		assert.equal(await analyzeCommits(analyzerOptions, {
			cwd: process.cwd(), commits: [{ hash: "abc123", message }], logger,
		}), expected);
	});
}

test("release analysis uses the highest bump across all commits", async () => {
	assert.equal(await analyzeCommits(analyzerOptions, {
		cwd: process.cwd(),
		commits: [
			{ hash: "abc123", message: "feat: add a comment filter" },
			{ hash: "def456", message: "fix: correct positioning" },
		],
		logger,
	}), "minor");
});

test("release notes render features, fixes, and breaking changes with the configured preset", async () => {
	const notesOptions = releaseConfig.plugins.find(([name]) => name === "@semantic-release/release-notes-generator")[1];
	const notes = await generateNotes(notesOptions, {
		cwd: process.cwd(),
		options: { repositoryUrl: "https://github.com/deepal/obsidian-inline-review-comments.git" },
		lastRelease: { version: "1.0.0", gitTag: "1.0.0" },
		nextRelease: { version: "2.0.0", gitTag: "2.0.0" },
		commits: [
			{ hash: "abcdef123456", message: "feat!: change the comment format\n\nBREAKING CHANGE: old comments must be migrated" },
			{ hash: "fedcba654321", message: "fix: correct comment positioning" },
		],
		logger,
	});
	assert.match(notes, /2\.0\.0/);
	assert.match(notes, /change the comment format/);
	assert.match(notes, /correct comment positioning/);
	assert.match(notes, /BREAKING CHANGES/);
	assert.match(notes, /old comments must be migrated/);
});
