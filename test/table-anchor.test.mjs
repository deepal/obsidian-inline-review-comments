import assert from "node:assert/strict";
import { test } from "node:test";
import { tableRowIndex, TableResizeObserver } from "../src/table-anchor.ts";

test("table source lines map headers and body rows without counting the delimiter", () => {
	const lines = ["Intro", "| Header | Other |", "| :--- | ---: |", "| a\\|b | `x|y` |", "| last | value |", "After"];
	assert.equal(tableRowIndex(lines, 1, 4, 1, 3), 0);
	assert.equal(tableRowIndex(lines, 1, 4, 2, 3), null);
	assert.equal(tableRowIndex(lines, 1, 4, 3, 3), 1);
	assert.equal(tableRowIndex(lines, 1, 4, 4, 3), 2);
	assert.equal(tableRowIndex(lines, 1, 4, 5, 3), null);
	assert.equal(tableRowIndex(lines, 1, 4, 4, 2), null);
});

test("row mappings follow inserted/deleted rows and isolate consecutive tables", () => {
	let lines = ["A | B", "--- | ---", "a | b", "", "C | D", "--- | ---", "c | d"];
	assert.equal(tableRowIndex(lines, 0, 6, 6, 2), 1);
	assert.equal(tableRowIndex(lines, 0, 2, 6, 2), null);
	lines.splice(2, 0, "new | row");
	assert.equal(tableRowIndex(lines, 0, 3, 3, 3), 2);
	lines.splice(2, 1);
	assert.equal(tableRowIndex(lines, 0, 2, 2, 2), 1);
});

test("quoted and single-column tables map safely; incomplete tables fall back", () => {
	assert.equal(tableRowIndex(["> | Header |", "> | --- |", "> | Value |"], 0, 2, 2, 2), 1);
	assert.equal(tableRowIndex(["| Header |", "| --- |"], 0, 1, 0, 1), 0);
	assert.equal(tableRowIndex(["| Header |", "| invalid |", "| Value |"], 0, 2, 2, 2), null);
	assert.equal(tableRowIndex(["| Header |", "| --- |", "| Value |"], 0, 2, 2, 0), null);
});

test("table observers reconcile replacements without reobserving unchanged tables", () => {
	let callback, observed = [], unobserved = [], disconnected = false, redraws = 0;
	globalThis.ResizeObserver = class {
		constructor(cb) { callback = cb; } observe(el) { observed.push(el); } unobserve(el) { unobserved.push(el); } disconnect() { disconnected = true; }
	};
	const watcher = new TableResizeObserver(() => redraws++), first = {}, second = {};
	watcher.update([first]); watcher.update([first]); assert.deepEqual(observed, [first]);
	watcher.update([second]); assert.deepEqual(unobserved, [first]); assert.deepEqual(observed, [first, second]);
	callback(); assert.equal(redraws, 1); watcher.destroy(); assert.equal(disconnected, true);
});
