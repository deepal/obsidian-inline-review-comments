import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComments, splitAuthor, splitQuote, groupComments } from "../src/parser.ts";

test("parses a simple inline comment", () => {
	const text = "This is an %%inline%% comment.";
	const [c] = parseComments(text);
	assert.equal(c.body, "inline");
	assert.equal(c.author, null);
	assert.equal(c.lineStart, 0);
	assert.equal(c.lineEnd, 0);
	assert.equal(text.slice(c.from, c.to), "%%inline%%");
});

test("parses the author convention", () => {
	const [c] = parseComments("Text %% ::deepal:: looks good to me %%");
	assert.equal(c.author, "deepal");
	assert.equal(c.body, "looks good to me");
});

test("parses a multi-line block comment", () => {
	const text = "Para one.\n\n%%\nThis is a block comment.\nIt spans lines.\n%%\n\nPara two.";
	const [c] = parseComments(text);
	assert.equal(c.body, "This is a block comment.\nIt spans lines.");
	assert.equal(c.lineStart, 2);
	assert.equal(c.lineEnd, 5);
});

test("ignores %% inside a fenced code block", () => {
	const text = "```\nnot a %%comment%% here\n```\n\nbut %%this is%% one";
	const comments = parseComments(text);
	assert.equal(comments.length, 1);
	assert.equal(comments[0].body, "this is");
});

test("ignores %% inside inline code", () => {
	const text = "use `%%not a comment%%` but %%real one%%";
	const comments = parseComments(text);
	assert.equal(comments.length, 1);
	assert.equal(comments[0].body, "real one");
});

test("handles multiple comments with correct lines", () => {
	const text = "line0 %%a%%\nline1\nline2 %%b%%";
	const comments = parseComments(text);
	assert.equal(comments.length, 2);
	assert.equal(comments[0].lineStart, 0);
	assert.equal(comments[1].lineStart, 2);
});

test("groups back-to-back comments into threads", () => {
	// Adjacent (same line) and consecutive lines = one thread.
	const text = "%% ::a:: one %%%% ::b:: two %%\n%% ::c:: three %%";
	const threads = groupComments(parseComments(text), text);
	assert.equal(threads.length, 1);
	assert.equal(threads[0].length, 3);
});

test("a blank line or text between starts a new thread", () => {
	const blank = "%% ::a:: one %%\n\n%% ::b:: two %%";
	assert.equal(groupComments(parseComments(blank), blank).length, 2);

	const between = "%% ::a:: one %% some text %% ::b:: two %%";
	assert.equal(groupComments(parseComments(between), between).length, 2);
});

test("splitAuthor handles author with spaces", () => {
	assert.deepEqual(splitAuthor("::Jane Doe:: hello"), {
		author: "Jane Doe",
		body: "hello",
	});
	assert.deepEqual(splitAuthor("no author here"), {
		author: null,
		body: "no author here",
	});
});

test("splitQuote extracts a leading {quote} segment", () => {
	assert.deepEqual(splitQuote("{quote}the fox jumps{/quote} my comment"), {
		quote: "the fox jumps",
		body: "my comment",
	});
	assert.deepEqual(splitQuote("no quote here"), {
		quote: null,
		body: "no quote here",
	});
});

test("splitQuote allows an empty body after the quote", () => {
	assert.deepEqual(splitQuote("{quote}just the quote{/quote}"), {
		quote: "just the quote",
		body: "",
	});
});

test("parses author, quote and body together", () => {
	const [c] = parseComments(
		"Text %% ::deepal:: {quote}the fox jumps{/quote} needs a citation %%"
	);
	assert.equal(c.author, "deepal");
	assert.equal(c.quote, "the fox jumps");
	assert.equal(c.body, "needs a citation");
});

test("a comment without a quote has quote === null", () => {
	const [c] = parseComments("Text %% ::deepal:: looks good %%");
	assert.equal(c.quote, null);
	assert.equal(c.body, "looks good");
});

test("a multi-line quoted excerpt is preserved", () => {
	const [c] = parseComments("%% {quote}line one\nline two{/quote} comment %%");
	assert.equal(c.quote, "line one\nline two");
	assert.equal(c.body, "comment");
});
