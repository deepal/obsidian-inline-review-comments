import { groupComments, parseComments, ParsedComment } from "./parser";

/**
 * Builds the markdown for a reply: a single space followed by an authored
 * comment, so it sits right after the previous one (same line) and groups into
 * the same thread without adding a new line.
 */
export function replyMarkdown(username: string, text: string): string {
	const name = username.trim();
	return ` ${name ? `%% ::${name}:: ` : "%% "}${text} %%`;
}

export function commentMarkdown(username: string, text: string, quote?: string | null, id?: string): string {
	const name = username.trim();
	const prefix = name ? `%% ::${name}:: ` : "%% ";
	// Literal delimiters must not terminate the surrounding comment or forge identity metadata.
	const safe = safeCommentText(text);
	return `${prefix}${quote ? `{quote}${quote}{/quote} ` : ""}${safe}${id ? ` <!-- aio-comment:${id} -->` : ""} %%`;
}

function safeCommentText(text: string): string {
	return text.replace(/%%/g, "&#37;&#37;").replace(/<!-- aio-/g, "&lt;!-- aio-");
}

/** Replace a posted body while keeping its original author, quote and internal IDs. */
export function editCommentChange(text: string, target: ParsedComment, body: string): { from: number; to: number; insert: string } | null {
	if (!body.trim() || target.from < 0) return null;
	let match: ParsedComment | null;
	if (target.id) match = locate(text, target);
	else {
		const candidates = parseComments(text).filter((c) => !c.id && c.author === target.author && c.body === target.body && c.quote === target.quote && c.replyTo === target.replyTo);
		match = candidates.find((c) => c.from === target.from) ?? (candidates.length === 1 ? candidates[0] : null);
	}
	if (!match) return null;
	if (body.trim() === match.body) return { from: match.from, to: match.from, insert: "" };
	let from = match.from + 2;
	const end = match.to - 2;
	const author = /^\s*::\s*[^:\n]+?\s*::\s*/.exec(text.slice(from, end));
	from += author ? author[0].length : /^\s*/.exec(text.slice(from, end))![0].length;
	const quote = /^\{quote\}[\s\S]*?\{\/quote\}\s*/.exec(text.slice(from, end));
	if (quote) from += quote[0].length;
	const previous = text.slice(from, end);
	const metadata = previous.match(/<!-- aio-(?:comment|reply):[a-zA-Z0-9_-]+ -->/g) ?? [];
	const trailing = /\s*$/.exec(previous)![0];
	return { from, to: end, insert: `${safeCommentText(body.trim())}${metadata.length ? ` ${metadata.join(" ")}` : ""}${trailing || " "}` };
}

/** Fill only this unchanged, uniquely identified placeholder. */
export function initialCommentChange(text: string, target: ParsedComment, body: string): { from: number; to: number; insert: string } | null {
	if (!target.id || target.body.trim() || !body.trim()) return null;
	const match = locate(text, target);
	if (!match || match.body.trim()) return null;
	const marker = text.indexOf(`<!-- aio-comment:${match.id} -->`, match.from);
	if (marker < match.from || marker >= match.to) return null;
	// Insert before the ID without rewriting the author or the verbatim quotation.
	return { from: marker, to: marker, insert: `${safeCommentText(body.trim())} ` };
}

/**
 * Re-parses `text` and locates the comment matching `target` by (author, body),
 * choosing the occurrence whose `from` is closest to the target. This keeps
 * edits correct even if the file changed since the card was rendered.
 */
function locate(text: string, target: ParsedComment): ParsedComment | null {
	const comments = parseComments(text);
	if (target.id) {
		const matches = comments.filter((c) => c.id === target.id);
		const match = matches.length === 1 ? matches[0] : null;
		return match && match.author === target.author && match.body === target.body && match.quote === target.quote && match.replyTo === target.replyTo ? match : null;
	}
	const candidates = comments.filter(
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

/** Append after the current last reply, including replies added since rendering. */
export function findReplyEnd(text: string, thread: ParsedComment[]): number | null {
	const root = locate(text, thread[0]);
	const last = locate(text, thread[thread.length - 1]);
	if (!root || !last) return null;
	const current = groupComments(parseComments(text), text).find((items) => items.some((c) => c.from === root.from) && items.some((c) => c.from === last.from));
	return current?.[current.length - 1].to ?? null;
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
