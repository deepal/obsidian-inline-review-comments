/**
 * Horizontal geometry of the card margin. Decides how much room the writing
 * column has to give up for the cards and where the cards sit, for both a
 * full-width column and Obsidian's centred "readable line length" column.
 *
 * The pure `computeMarginLayout` holds all of the arithmetic so it can be unit
 * tested; `measureMargin` and `applyMargin` are the thin DOM adapters used by
 * the editor and Reading view renderers.
 */

/** Space between the right edge of the text and the cards. */
export const CARD_GAP = 24;
/** Space between the cards and the right edge of the scroller. */
export const EDGE_GAP = 12;
/** Below this text width, cards shrink instead of squeezing the text further. */
export const MIN_TEXT_WIDTH = 320;
/** Cards never shrink below this width, even on a phone. */
export const MIN_CARD_WIDTH = 160;

export interface MarginMeasurement {
	/** Scroller padding-box width without its scrollbar (`clientWidth`). */
	scrollerWidth: number;
	paddingLeft: number;
	paddingRight: number;
	/**
	 * Width cap of the writing column without any reserve of ours, e.g. 700 for
	 * readable line length. `null` when the column fills the scroller.
	 */
	columnMaxWidth: number | null;
	/** Card width from the settings. */
	cardWidth: number;
}

export interface MarginLayout {
	/** Padding added to the right of the writing column, and to its width cap. */
	reserve: number;
	/** Card width actually used; smaller than the setting only on narrow panes. */
	cardWidth: number;
	/** Left edge of the cards, in scroller padding-box coordinates. */
	cardLeft: number;
	/** Width left for the text. */
	textWidth: number;
}

/**
 * Places the cards right next to the text and reserves only the space the
 * free margin cannot provide.
 *
 * Readable line length centres the column, so widening its cap by `reserve`
 * while padding it by `reserve` keeps the text at its full width and shifts it
 * left by `reserve / 2`. Once the pane is too narrow for that, the column
 * fills the pane and the text shrinks instead.
 *
 * Example, 1400px pane, 32px margins, 700px cap, 240px cards: the free space
 * right of the column is 32 + (1336 - 700) / 2 = 350px, enough for
 * 24 + 240 + 12 = 276px, so reserve = 0 and the cards start at 1074px.
 */
export function computeMarginLayout(m: MarginMeasurement): MarginLayout {
	const available = Math.max(0, m.scrollerWidth - m.paddingLeft - m.paddingRight);
	const cap = m.columnMaxWidth ?? Infinity;
	const place = (cardWidth: number): MarginLayout => {
		const needed = CARD_GAP + cardWidth + EDGE_GAP;
		const natural = Math.min(cap, available);
		const naturalRight = m.paddingRight + (available - natural) / 2;
		let reserve: number, columnWidth: number;
		if (naturalRight >= needed) {
			reserve = 0;
			columnWidth = natural;
		} else if (cap + 2 * (needed - naturalRight) <= available) {
			reserve = 2 * (needed - naturalRight);
			columnWidth = cap + reserve;
		} else {
			reserve = Math.min(available, needed - m.paddingRight);
			columnWidth = available;
		}
		const textLeft = m.paddingLeft + (available - columnWidth) / 2;
		const textWidth = columnWidth - reserve;
		return { reserve, cardWidth, cardLeft: textLeft + textWidth + CARD_GAP, textWidth };
	};

	const preferred = place(m.cardWidth);
	if (preferred.textWidth >= Math.min(MIN_TEXT_WIDTH, cap) || m.cardWidth <= MIN_CARD_WIDTH) return preferred;
	// Width that leaves exactly MIN_TEXT_WIDTH for the text in a full-width column.
	const fitting = available - MIN_TEXT_WIDTH - CARD_GAP - EDGE_GAP + m.paddingRight;
	return place(Math.max(MIN_CARD_WIDTH, Math.min(m.cardWidth, fitting)));
}

/** Reads `"700px"` as 700; anything else (`"none"`, `"80%"`, `""`) as null. */
export function parsePx(value: string): number | null {
	const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
	return match ? Number(match[1]) : null;
}

/**
 * Measures the scroller and the element Obsidian caps for readable line length
 * (`.cm-sizer` or `.markdown-preview-sizer`). While our CSS widens that cap by
 * the applied reserve, the reserve is subtracted again so the result never
 * depends on our own previous layout.
 */
export function measureMargin(scroller: HTMLElement, column: HTMLElement | null, cardWidth: number): MarginMeasurement {
	const win = scroller.win;
	const style = win.getComputedStyle(scroller);
	const applied = scroller.classList.contains("irc-has-comments") && scroller.ownerDocument.body.classList.contains("irc-active")
		? parsePx(scroller.style.getPropertyValue("--irc-reserve")) ?? 0 : 0;
	const cap = column ? parsePx(win.getComputedStyle(column).maxWidth) : null;
	return {
		scrollerWidth: scroller.clientWidth,
		paddingLeft: parsePx(style.paddingLeft) ?? 0,
		paddingRight: parsePx(style.paddingRight) ?? 0,
		columnMaxWidth: cap === null ? null : Math.max(0, cap - applied),
		cardWidth,
	};
}

/** Writes the reserve consumed by the `.irc-has-comments` rules in styles.css. */
export function applyMargin(scroller: HTMLElement, layout: MarginLayout | null): void {
	if (layout) scroller.style.setProperty("--irc-reserve", `${layout.reserve}px`);
	else scroller.style.removeProperty("--irc-reserve");
}
