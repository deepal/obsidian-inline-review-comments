import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSettings, legacyUsername, DEFAULT_SETTINGS } from "../src/settings-data.ts";

test("missing or invalid stored settings fall back to defaults", () => {
	for (const value of [undefined, null, [], "invalid", 42]) {
		assert.deepEqual(normalizeSettings(value), DEFAULT_SETTINGS);
	}
});

test("valid settings survive and card width stays within the supported range", () => {
	const value = normalizeSettings({ username: "Alice", enabled: false, overrideToggleComment: false, cardWidth: 999, hideCommentMarkers: "yes" });
	assert.equal("username" in value, false, "the author is not a shared setting");
	assert.equal(value.enabled, false);
	assert.equal(value.overrideToggleComment, false);
	assert.equal(value.cardWidth, 360);
	assert.equal(value.hideCommentMarkers, true);
	assert.equal(normalizeSettings({ cardWidth: NaN }).cardWidth, 240);
	assert.equal(normalizeSettings({ cardWidth: 175 }).cardWidth, 180);
	assert.equal(normalizeSettings({ cardWidth: 253 }).cardWidth, 250);
});

// data.json written by 4.x still carries the shared author name.
test("legacy author name is read only as a prefill", () => {
	assert.equal(legacyUsername({ username: "  Alice ", enabled: true }), "Alice");
	for (const value of [undefined, null, [], "Alice", { username: 7 }, {}]) assert.equal(legacyUsername(value), "");
});
