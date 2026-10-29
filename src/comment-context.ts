/** Markdown containers around a comment, independent of the rendered editor. */
export function commentContext(text: string, at: number): { table: boolean; prefix: string } {
	const lines = text.split("\n");
	const line = text.slice(0, at).split("\n").length - 1;
	const before = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
	const quote = /^[ \t]*(?:>[ \t]*)+/.exec(before)?.[0] ?? "";
	const rest = before.slice(quote.length);
	const list = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.exec(rest)?.[0];
	const footnote = /^[ \t]*\[\^[^\]]+\]:[ \t]+/.test(rest);
	const prefix = quote + (footnote ? "    " : list ? " ".repeat(list.length) : /^[ \t]*/.exec(rest)![0]);
	const strip = (value: string) => value.replace(/^[ \t]*(?:>[ \t]*)*/, "").trim();
	const hasPipe = (value: string) => /(^|[^\\])(?:\\\\)*\|/.test(value);
	const delimiter = (value: string) => {
		const raw = strip(value);
		return raw.includes("|") && raw.replace(/^\|/, "").replace(/\|$/, "").split("|").every((cell) => /^\s*:?-+:?\s*$/.test(cell));
	};
	let table = false;
	if (hasPipe(lines[line] ?? "")) {
		if (delimiter(lines[line + 1] ?? "")) table = true;
		else for (let i = line - 1; i > 0 && hasPipe(lines[i]); i--) {
			if (delimiter(lines[i]) && hasPipe(lines[i - 1])) { table = true; break; }
		}
	}
	return { table, prefix };
}

/** Keep comments inside their table cell, quote/callout, or list item. */
export function encodeComment(text: string, at: number, value: string): string {
	const { table, prefix } = commentContext(text, at);
	if (table) return value.replace(/(\\*)\|/g, (_all, slashes: string) => `${slashes}${slashes.length % 2 ? "" : "\\"}|`).replace(/\r?\n/g, "<br>");
	return prefix ? value.replace(/\n/g, `\n${prefix}`) : value;
}

export function decodeComment(text: string, at: number, value: string): string {
	const { table, prefix } = commentContext(text, at);
	// Only structural prefixes supplied by the enclosing container are removed.
	// A quote written in the comment itself remains a quote (and cannot mention).
	if (prefix) value = value.split("\n").map((line, i) => i && line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n");
	return table ? decodeTableComment(value) : value;
}

/** Cell editors contain the cell text alone, without its Markdown table. */
export function decodeTableComment(value: string): string {
	return value.replace(/\\\|/g, "|").replace(/<br\s*\/?\s*>/gi, "\n");
}
