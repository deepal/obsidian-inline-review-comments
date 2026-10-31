import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthorStore, gitUserName } from "../src/author.ts";

/** Mirrors Obsidian's saveLocalStorage, which deletes falsy values. */
function host() {
	const values = new Map();
	return {
		values,
		loadLocalStorage: (key) => values.has(key) ? JSON.parse(values.get(key)) : null,
		saveLocalStorage: (key, data) => data ? values.set(key, JSON.stringify(data)) : values.delete(key),
	};
}

test("author store distinguishes unset, anonymous and named", () => {
	const storage = host(), store = new AuthorStore(storage, "plugin:author");
	assert.equal(store.get(), null);
	store.set("");
	assert.equal(store.get(), "", "anonymous survives Obsidian's falsy deletion");
	store.set("  Alice  ");
	assert.equal(store.get(), "Alice");
	assert.deepEqual([...storage.values.keys()], ["plugin:author"]);
});

test("author store ignores malformed stored values", () => {
	for (const value of [null, "Alice", 42, [], { name: 7 }, {}]) {
		const store = new AuthorStore({ loadLocalStorage: () => value, saveLocalStorage() {} }, "k");
		assert.equal(store.get(), null, JSON.stringify(value));
	}
});

test("git user.name is read from the user section only", () => {
	assert.equal(gitUserName("[core]\n\tname = core\n[user]\n\temail = a@b\n\tname = Ada Lovelace\n"), "Ada Lovelace");
	assert.equal(gitUserName("[user]\r\n\tname = Ada\r\n[remote \"origin\"]\r\n\tname = other\r\n"), "Ada");
	assert.equal(gitUserName("[user \"sub\"]\n\tname = nope\n"), null);
	assert.equal(gitUserName("[core]\n\tbare = false\n"), null);
	assert.equal(gitUserName(""), null);
});

test("git user.name handles quotes, comments, case and repeats", () => {
	assert.equal(gitUserName("[user]\n\tname = \"Ada \\\"A.\\\" Lovelace\" ; me\n"), "Ada \"A.\" Lovelace");
	assert.equal(gitUserName("[User]\n\tName = Ada # comment\n"), "Ada");
	assert.equal(gitUserName("[user]\n\tname = First\n[user]\n\tname = Second\n"), "Second");
	assert.equal(gitUserName("[user]\n\tname =\n"), null);
});

// A typical ~/.gitconfig written by `git config --global`.
test("git user.name from a real-world global config", () => {
	const config = "[user]\n\tname = Marc Example\n\temail = marc@example.com\n[core]\n\tautocrlf = true\n[init]\n\tdefaultBranch = main\n";
	assert.equal(gitUserName(config), "Marc Example");
});
