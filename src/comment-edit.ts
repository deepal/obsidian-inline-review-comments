import { parseComments, ParsedComment } from "./parser";

/**
 * Builds the markdown for a reply: a single space followed by an authored
 * comment, so it sits right after the previous one (same line) and groups into
 * the same thread without adding a new line.
 */
export function replyMarkdown(username: string, text: string): string {
	const name = username.trim();
	const prefix = name ? `%% ::${name}:: ` : `%% `;
	return ` ${prefix}${text} %%`;
}

/**
 * Re-parses `text` and locates the comment matching `target` by (author, body),
 * choosing the occurrence whose `from` is closest to the target. This keeps
 * edits correct even if the file changed since the card was rendered.
 */
function locate(text: string, target: ParsedComment): ParsedComment | null {
	const candidates = parseComments(text).filter(
		(c) =>
			c.author === target.author &&
			c.body === target.body &&
			c.quote === target.quote
	);
	if (candidates.length === 0) return null;
	candidates.sort(
		(a, b) => Math.abs(a.from - target.from) - Math.abs(b.from - target.from)
	);
	return candidates[0];
}

/** Extends `[from, to)` to swallow a trailing newline when it spans whole lines. */
function tidy(text: string, from: number, to: number): { from: number; to: number } {
	const beforeIsLineStart = from === 0 || text[from - 1] === "\n";
	const afterIsLineEnd = to >= text.length || text[to] === "\n";
	if (beforeIsLineStart && afterIsLineEnd && to < text.length) to += 1;
	return { from, to };
}

/** Offset just past the closing `%%` of `target`, where a reply is inserted. */
export function findCommentEnd(text: string, target: ParsedComment): number | null {
	return locate(text, target)?.to ?? null;
}

/** Char range to remove for a single comment (with trailing-newline tidy). */
export function findRemovalRange(
	text: string,
	target: ParsedComment
): { from: number; to: number } | null {
	const match = locate(text, target);
	if (!match) return null;
	return tidy(text, match.from, match.to);
}

/**
 * Char range spanning an entire thread — from the first comment's start to the
 * last comment's end (the comments are contiguous, separated only by
 * whitespace) — used to resolve/delete the whole thread at once.
 */
export function findThreadRange(
	text: string,
	thread: ParsedComment[]
): { from: number; to: number } | null {
	const first = locate(text, thread[0]);
	const last = thread.length === 1 ? first : locate(text, thread[thread.length - 1]);
	if (!first || !last) return null;
	return tidy(text, first.from, last.to);
}
