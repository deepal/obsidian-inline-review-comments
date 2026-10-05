/**
 * Pure parsing utilities for Obsidian inline/block comments (`%% ... %%`).
 *
 * This module has no Obsidian dependencies so it can be unit-tested in plain
 * Node. It is the single source of truth for comment offsets, line numbers,
 * author and body — shared by the editing path, the reading path and delete.
 */

export interface ParsedComment {
	/** Char offset of the opening `%%` in the source text. */
	from: number;
	/** Char offset just past the closing `%%`. */
	to: number;
	/** 0-based line of the opening `%%`. */
	lineStart: number;
	/** 0-based line of the closing `%%`. */
	lineEnd: number;
	/** Author parsed from the `%% ::name:: body %%` convention, else null. */
	author: string | null;
	/**
	 * Quoted excerpt from the document the comment refers to, parsed from a
	 * leading `{quote}...{/quote}` segment, else null. The excerpt lives only
	 * inside the comment — the original prose stays untouched in the note.
	 */
	quote: string | null;
	/**
	 * Comment text with the `%%` markers, the `::author::` prefix and any
	 * `{quote}...{/quote}` segment removed.
	 */
	body: string;
}

/**
 * Returns char ranges `[start, end)` that should be treated as code (fenced
 * code blocks and inline code spans) so `%%` inside them is ignored.
 */
function findCodeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	// Fenced code blocks: ``` or ~~~ fences (allow leading whitespace). The
	// block runs to a matching closing fence line, or to end-of-input if the
	// fence is never closed (`(?![\s\S])` asserts end of string).
	const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
	}

	// Inline code spans: matched runs of backticks on a single line. Restricted
	// to a single line (`[^\n]`) so an unbalanced backtick can't pair with one
	// lines away and engulf a whole region (e.g. `%% … %%` comments below it).
	const inline = /(`+)(?:(?!\1)[^\n])*?\1/g;
	while ((m = inline.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		if (!ranges.some(([s, e]) => start >= s && end <= e)) {
			ranges.push([start, end]);
		}
	}

	return ranges;
}

function isInside(ranges: Array<[number, number]>, pos: number): boolean {
	return ranges.some(([s, e]) => pos >= s && pos < e);
}

/** Builds a function mapping a char offset to its 0-based line number. */
function makeLineLookup(text: string): (offset: number) => number {
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") lineStarts.push(i + 1);
	}
	return (offset: number) => {
		// Binary search for the greatest lineStart <= offset.
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
}

const AUTHOR_RE = /^::\s*([^:\n]+?)\s*::\s*([\s\S]*)$/;

/** Splits a trimmed comment inner string into `{author, body}`. */
export function splitAuthor(inner: string): { author: string | null; body: string } {
	const trimmed = inner.trim();
	const m = AUTHOR_RE.exec(trimmed);
	if (m) {
		return { author: m[1].trim(), body: m[2].trim() };
	}
	return { author: null, body: trimmed };
}

const QUOTE_RE = /^\{quote\}([\s\S]*?)\{\/quote\}\s*/;

/**
 * Splits a leading `{quote}...{/quote}` segment off the front of a comment
 * body, returning the quoted excerpt and the remaining body. With no such
 * segment, `quote` is null and the body is returned unchanged.
 */
export function splitQuote(body: string): { quote: string | null; body: string } {
	const m = QUOTE_RE.exec(body);
	if (m) {
		return { quote: m[1].trim(), body: body.slice(m[0].length).trim() };
	}
	return { quote: null, body };
}

/**
 * Parses all `%% ... %%` comments in `text`, skipping any that fall inside
 * fenced code blocks or inline code spans.
 */
export function parseComments(text: string): ParsedComment[] {
	const codeRanges = findCodeRanges(text);
	const lineOf = makeLineLookup(text);
	const comments: ParsedComment[] = [];

	const re = /%%([\s\S]*?)%%/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (isInside(codeRanges, from)) continue;

		const { author, body: rest } = splitAuthor(m[1]);
		const { quote, body } = splitQuote(rest);
		comments.push({
			from,
			to,
			lineStart: lineOf(from),
			lineEnd: lineOf(to - 1),
			author,
			quote,
			body,
		});
	}

	return comments;
}

/** Whitespace with at most one line break — i.e. adjacent or directly stacked. */
const THREAD_GAP_RE = /^[^\S\n]*\n?[^\S\n]*$/;

/**
 * Groups back-to-back comments into threads. Two comments belong to the same
 * thread when only whitespace (and at most one line break) separates them; a
 * blank line or any text between them starts a new thread. Input is assumed to
 * be in document order (as returned by `parseComments`).
 */
export function groupComments(
	comments: ParsedComment[],
	text: string
): ParsedComment[][] {
	const threads: ParsedComment[][] = [];
	let current: ParsedComment[] = [];

	for (const c of comments) {
		if (current.length === 0) {
			current = [c];
			continue;
		}
		const prev = current[current.length - 1];
		if (THREAD_GAP_RE.test(text.slice(prev.to, c.from))) {
			current.push(c);
		} else {
			threads.push(current);
			current = [c];
		}
	}
	if (current.length) threads.push(current);
	return threads;
}
