import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_GAP, EDGE_GAP, MIN_CARD_WIDTH, MIN_TEXT_WIDTH, computeMarginLayout, measureMargin, parsePx } from "../src/margin-geometry.ts";

const desktop = { paddingLeft: 32, paddingRight: 32, cardWidth: 240 };
const needed = (card) => CARD_GAP + card + EDGE_GAP;

/** Every layout must keep the card inside the scroller and right of the text. */
function assertSane(m, layout) {
	assert.ok(layout.reserve >= 0);
	assert.ok(layout.textWidth >= 0);
	assert.ok(layout.cardLeft + layout.cardWidth + EDGE_GAP <= m.scrollerWidth + 1e-9, "card stays inside the scroller");
	return layout;
}

// Readable line length on a wide monitor: the gutter beside the centred
// column already fits the cards, so the text keeps its 700px.
test("readable column on a wide pane reserves nothing and puts cards next to the text", () => {
	const m = { ...desktop, scrollerWidth: 1400, columnMaxWidth: 700 };
	const layout = assertSane(m, computeMarginLayout(m));
	assert.deepEqual(layout, { reserve: 0, cardWidth: 240, cardLeft: 350 + 700 + CARD_GAP, textWidth: 700 });
});

test("readable column threshold: gutter fits exactly, and one pixel short", () => {
	// Free space right of the column: 32 + (W - 64 - 700) / 2 === 276 at W = 1252.
	const exact = computeMarginLayout({ ...desktop, scrollerWidth: 1252, columnMaxWidth: 700 });
	assert.equal(exact.reserve, 0);
	assert.equal(exact.textWidth, 700);
	const short = computeMarginLayout({ ...desktop, scrollerWidth: 1251, columnMaxWidth: 700 });
	assert.equal(short.reserve, 1);
	assert.equal(short.textWidth, 700);
	assert.equal(short.cardLeft + 240 + EDGE_GAP, 1251);
});

// A laptop-sized pane: the column shifts left to make room but keeps its width.
test("readable column on a medium pane shifts left without shrinking the text", () => {
	const m = { ...desktop, scrollerWidth: 1100, columnMaxWidth: 700 };
	const layout = assertSane(m, computeMarginLayout(m));
	assert.equal(layout.textWidth, 700);
	assert.equal(layout.reserve, 2 * (needed(240) - (32 + (1036 - 700) / 2)));
	assert.equal(layout.cardLeft + 240 + EDGE_GAP, 1100);
});

test("readable column fills the pane once shifting is not enough, then the text shrinks", () => {
	// Shifting covers up to W = 64 + 700 + 276 - 32 = 1008.
	const edge = computeMarginLayout({ ...desktop, scrollerWidth: 1008, columnMaxWidth: 700 });
	assert.equal(edge.textWidth, 700);
	const below = computeMarginLayout({ ...desktop, scrollerWidth: 1007, columnMaxWidth: 700 });
	assert.equal(below.textWidth, 699);
	assert.equal(below.reserve, needed(240) - 32);
	const m = { ...desktop, scrollerWidth: 900, columnMaxWidth: 700 };
	assert.equal(assertSane(m, computeMarginLayout(m)).textWidth, 900 - 64 - (needed(240) - 32));
});

test("full-width column reserves the card space minus the scroller padding", () => {
	for (const scrollerWidth of [800, 1400, 2400]) {
		const m = { ...desktop, scrollerWidth, columnMaxWidth: null };
		const layout = assertSane(m, computeMarginLayout(m));
		assert.equal(layout.reserve, needed(240) - 32);
		assert.equal(layout.textWidth, scrollerWidth - 64 - layout.reserve);
		assert.equal(layout.cardLeft + 240 + EDGE_GAP, scrollerWidth);
	}
});

test("every configured card width keeps cards beside the readable column", () => {
	for (const cardWidth of [180, 240, 360]) {
		for (const scrollerWidth of [700, 1000, 1200, 1600]) {
			const m = { ...desktop, cardWidth, scrollerWidth, columnMaxWidth: 700 };
			const layout = assertSane(m, computeMarginLayout(m));
			const roomForFullText = scrollerWidth >= 64 + 700 + needed(cardWidth) - 32;
			assert.equal(layout.textWidth === 700, roomForFullText, `${cardWidth}px cards in a ${scrollerWidth}px pane`);
			assert.ok(layout.textWidth <= 700);
		}
	}
});

// Themes and plugins such as custom note widths change --file-line-width.
test("a non-default readable width is honoured", () => {
	const layout = computeMarginLayout({ ...desktop, scrollerWidth: 1800, columnMaxWidth: 1000 });
	assert.deepEqual(layout, { reserve: 0, cardWidth: 240, cardLeft: 32 + 368 + 1000 + CARD_GAP, textWidth: 1000 });
	const narrowCap = computeMarginLayout({ ...desktop, scrollerWidth: 1400, columnMaxWidth: 200 });
	assert.equal(narrowCap.textWidth, 200, "a cap below the minimum text width does not shrink cards");
	assert.equal(narrowCap.cardWidth, 240);
});

// A phone in portrait: 390px wide with 24px margins.
test("narrow panes shrink cards to keep the text readable", () => {
	const phone = { paddingLeft: 24, paddingRight: 24, cardWidth: 240, scrollerWidth: 390, columnMaxWidth: 700 };
	const layout = assertSane(phone, computeMarginLayout(phone));
	assert.equal(layout.cardWidth, MIN_CARD_WIDTH);
	assert.ok(layout.textWidth > 100);
	// Mid-size pane: the card shrinks just enough for MIN_TEXT_WIDTH of text.
	const split = { ...desktop, scrollerWidth: 600, columnMaxWidth: null };
	const fitted = assertSane(split, computeMarginLayout(split));
	assert.equal(fitted.textWidth, MIN_TEXT_WIDTH);
	assert.ok(fitted.cardWidth > MIN_CARD_WIDTH && fitted.cardWidth < 240);
	// Wide enough: no shrinking.
	const wide = computeMarginLayout({ ...desktop, scrollerWidth: 1000, columnMaxWidth: null });
	assert.equal(wide.cardWidth, 240);
});

test("degenerate panes never produce negative sizes", () => {
	for (const scrollerWidth of [0, 1, 64, 200]) {
		const layout = computeMarginLayout({ ...desktop, scrollerWidth, columnMaxWidth: 700 });
		assert.ok(layout.reserve >= 0 && layout.textWidth >= 0 && layout.cardWidth >= MIN_CARD_WIDTH);
	}
});

test("applying the reserve and measuring again yields the same layout", () => {
	const style = (values) => ({ maxWidth: "none", paddingLeft: "32px", paddingRight: "32px", ...values });
	const body = { classList: { contains: (name) => name === "irc-active" } };
	for (const [scrollerWidth, cap] of [[1400, 700], [1100, 700], [900, 700], [1100, null], [390, 700]]) {
		const props = new Map();
		const scroller = {
			clientWidth: scrollerWidth, ownerDocument: { body },
			classList: { contains: (name) => name === "irc-has-comments" && props.size > 0 },
			style: { getPropertyValue: (name) => props.get(name) ?? "" },
			win: { getComputedStyle: (el) => el === scroller ? style({}) : style({ maxWidth: cap === null ? "none" : `${cap + (parsePx(props.get("--irc-reserve") ?? "") ?? 0)}px` }) },
		};
		const column = {};
		const first = computeMarginLayout(measureMargin(scroller, column, 240));
		props.set("--irc-reserve", `${first.reserve}px`);
		const second = computeMarginLayout(measureMargin(scroller, column, 240));
		assert.deepEqual(second, first, `stable at ${scrollerWidth}px`);
	}
});

test("parsePx accepts pixel lengths only", () => {
	assert.equal(parsePx("700px"), 700);
	assert.equal(parsePx(" 12.5px "), 12.5);
	assert.equal(parsePx("none"), null);
	assert.equal(parsePx("80%"), null);
	assert.equal(parsePx(""), null);
	assert.equal(parsePx("calc(80% + 10px)"), null);
});
