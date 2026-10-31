import { parseComments, type ParsedComment } from "./parser";
import { tableRowIndex } from "./table-anchor";

export interface SourceRange { from: number; to: number }
export interface MarkerTarget { container: HTMLElement; source: SourceRange; comment: ParsedComment }
interface Point { node: Node; offset: number }
interface VisibleText { text: string; before: Point[]; after: Point[] }
const ignored = ".irc-inline-avatar, .irc-margin-layer, .cm-editor, .internal-embed, .markdown-embed, .collapse-indicator, .heading-collapse-indicator, .callout-icon, .callout-fold, .footnote-backref, sup.footnote-ref, .math, [aria-hidden='true'], input, button, script, style, pre";
const blocks = "p, h1, h2, h3, h4, h5, h6, li, .callout-title-inner";
function excluded(el: Element, root: HTMLElement): boolean {
	const owner = el.closest(ignored);
	return !!owner && (owner === root || root.contains(owner));
}
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const stripQuote = (s: string) => s.replace(/^[ \t]*(?:>[ \t]*)*/, "");
const boundary = (s: string) => /^(?:#{1,6}\s|(?:[-+*]|\d+[.)])\s|\[\^[^\]]+\]:|\[!)/.test(stripQuote(s).trimStart());

/** Source offsets, not split('|'): escaped pipes and code spans stay in a cell. */
export function tableCellRanges(line: string): SourceRange[] {
	const ranges: SourceRange[] = [];
	let start = /^[ \t]*(?:>[ \t]*)*/.exec(line)![0].length;
	if (line[start] === "|") start++;
	let code = 0;
	for (let i = start; i < line.length; i++) {
		if (line[i] === "\\") { i++; continue; }
		if (line[i] === "`") {
			let end = i + 1;
			while (line[end] === "`") end++;
			const size = end - i;
			if (!code) {
				// An unmatched backtick is ordinary text, not a code span.
				const closing = line.indexOf("`".repeat(size), end);
				if (closing >= 0) code = size;
			} else if (code === size) code = 0;
			i = end - 1;
		} else if (line[i] === "|" && !code) {
			ranges.push({ from: start, to: i }); start = i + 1;
		}
	}
	if (line.slice(start).trim() || !ranges.length) ranges.push({ from: start, to: line.length });
	return ranges;
}

function withoutComments(text: string, range: SourceRange, comments: ParsedComment[], target?: ParsedComment): string {
	let result = "", at = range.from;
	for (const c of comments) {
		if (c.from < range.from || c.to > range.to) continue;
		result += text.slice(at, c.from) + (c === target ? "\u0000" : "");
		at = c.to;
	}
	return result + text.slice(at, range.to);
}

/** A text projection for matching, never an HTML renderer. Unrecognized syntax
 * simply fails the exact match and uses a structural fallback. */
function inlineText(source: string, doc: Document, depth = 0): string {
	if (depth > 8) return source;
	let out = "";
	for (let i = 0; i < source.length;) {
		const rest = source.slice(i);
		const escaped = /^\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.exec(rest);
		if (escaped) { out += escaped[1]; i += escaped[0].length; continue; }
		const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest);
		if (code) {
			let value = code[2].replace(/\n/g, " ");
			if (value.startsWith(" ") && value.endsWith(" ") && value.trim()) value = value.slice(1, -1);
			out += value; i += code[0].length; continue;
		}
		const wiki = /^(!?)\[\[([^\]\n]+)\]\]/.exec(rest);
		if (wiki) {
			if (!wiki[1]) { const value = wiki[2].split("|"); out += value.length > 1 ? value.slice(1).join("|") : value[0]; }
			i += wiki[0].length; continue;
		}
		const link = /^(!?)\[([^\]\n]*)\](?:\((?:\\.|[^()\n]|\([^()]*\))*\)|\[[^\]\n]*\])/.exec(rest);
		if (link) { if (!link[1]) out += inlineText(link[2], doc, depth + 1); i += link[0].length; continue; }
		const footnote = /^\[\^[^\]\n]+\]/.exec(rest);
		if (footnote) { i += footnote[0].length; continue; }
		const htmlComment = /^<!--[\s\S]*?-->/.exec(rest);
		if (htmlComment) { i += htmlComment[0].length; continue; }
		const autolink = /^<((?:https?:\/\/|mailto:)[^>]+)>/.exec(rest);
		if (autolink) { out += autolink[1].replace(/^mailto:/, ""); i += autolink[0].length; continue; }
		const tag = /^<\/?[a-zA-Z][^>]*>/.exec(rest);
		if (tag) { if (/^<br\b/i.test(tag[0])) out += " "; i += tag[0].length; continue; }
		const entity = /^&(?:#[0-9]+|#x[\da-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/.exec(rest);
		if (entity) {
			const Parser = doc.defaultView?.DOMParser;
			out += Parser ? new Parser().parseFromString(entity[0], "text/html").body.textContent ?? entity[0] : entity[0];
			i += entity[0].length; continue;
		}
		if (source[i] === "*" || source[i] === "_" || rest.startsWith("~~") || rest.startsWith("==")) { i += source[i] === "*" || source[i] === "_" ? 1 : 2; continue; }
		out += source[i++];
	}
	return out;
}

function project(source: string, doc: Document): { text: string; anchor: number } {
	const clean = source.replace(/^[ \t]*(?:>[ \t]*)+/gm, "")
		.replace(/^[ \t]*(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[\^[^\]]+\]:[ \t]*)/gm, "")
		.replace(/^\[![^\]]+\][+-]?[ \t]*/gm, "").replace(/[ \t]+#+[ \t]*$/gm, "");
	const projected = inlineText(clean, doc);
	const index = projected.indexOf("\u0000");
	const left = index < 0 ? projected : projected.slice(0, index);
	const text = normalize(projected.split("\u0000").join(""));
	let anchor = normalize(left).length;
	if (/\s$/.test(left) && anchor && text.length > anchor) anchor++;
	return { text, anchor };
}

function visibleText(root: HTMLElement): VisibleText {
	const chars: Array<{ value: string; before: Point; after: Point }> = [];
	const visit = (node: Node) => {
		if (node.nodeType === 3) {
			const text = node.textContent ?? "";
			for (let offset = 0; offset < text.length; offset++) chars.push({ value: text[offset], before: { node, offset }, after: { node, offset: offset + 1 } });
			return;
		}
		if (node.nodeType !== 1) return;
		const el = node as HTMLElement;
		if (el !== root && el.matches(ignored)) return;
		const children = Array.from(node.childNodes);
		for (const child of children) visit(child);
		if (/^(BR|P|DIV|LI|H[1-6])$/.test(el.tagName) && el !== root) chars.push({ value: " ", before: { node, offset: node.childNodes.length }, after: { node, offset: node.childNodes.length } });
	};
	visit(root);
	const result: VisibleText = { text: "", before: [], after: [] };
	let space: (typeof chars)[number] | undefined;
	for (const char of chars) {
		if (/\s/.test(char.value)) { space ??= char; continue; }
		if (space && result.text) { result.text += " "; result.before.push(space.before); result.after.push(space.after); }
		space = undefined;
		result.text += char.value; result.before.push(char.before); result.after.push(char.after);
	}
	return result;
}

export function markerTargets(root: HTMLElement, text: string, lineStart: number, lineEnd: number): MarkerTarget[] {
	const lines = text.split("\n"), starts = [0];
	for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
	// Obsidian relocates definitions into a generated footer. Its data-line is
	// relative to the footer source section and can therefore be negative.
	const footnotes = Array.from(root.querySelectorAll<HTMLElement>(".footnotes li[data-line]"));
	const footnoteSources = footnotes.flatMap((container) => {
		const first = lineStart + Number(container.dataset.line);
		if (!Number.isInteger(first) || first < 0 || !/^[ \t]*\[\^[^\]]+\]:/.test(lines[first] ?? "")) return [];
		let last = first;
		while (last + 1 < lines.length) {
			if (/^(?: {2,}|\t)/.test(lines[last + 1])) { last++; continue; }
			if (!lines[last + 1].trim()) {
				let next = last + 2;
				while (next < lines.length && !lines[next].trim()) next++;
				if (/^(?: {2,}|\t)/.test(lines[next] ?? "")) { last = next; continue; }
			}
			break;
		}
		return [{ container, first, last, source: { from: starts[first], to: starts[last] + lines[last].length } }];
	});
	const comments = parseComments(text).filter((c) => footnoteSources.length
		? footnoteSources.some((f) => c.lineStart >= f.first && c.lineStart <= f.last)
		: c.lineStart >= lineStart && c.lineStart <= lineEnd);
	const tables = root.instanceOf(HTMLTableElement) ? [root] : Array.from(root.querySelectorAll<HTMLTableElement>("table")).filter((t) => !excluded(t, root));
	const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>(blocks))].filter((el) => !excluded(el, root) && !el.closest("table"));
	const tableSources: Array<{ from: number; to: number }> = [];
	for (let i = lineStart + 1; i <= lineEnd; i++) {
		if (!/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(stripQuote(lines[i] ?? "")) || !lines[i]?.includes("|")) continue;
		let end = i;
		while (end < lineEnd && lines[end + 1]?.includes("|") && stripQuote(lines[end + 1]).trim()) end++;
		tableSources.push({ from: i - 1, to: end }); i = end;
	}
	return comments.flatMap((comment): MarkerTarget[] => {
		const footnote = footnoteSources.find((f) => comment.lineStart >= f.first && comment.lineStart <= f.last);
		if (footnote) return [{ container: footnote.container.querySelector<HTMLElement>("p") ?? footnote.container, source: footnote.source, comment }];
		const tableIndex = tableSources.findIndex((range) => comment.lineStart >= range.from && comment.lineStart <= range.to);
		if (tableIndex >= 0) {
			const table = tables[tableIndex], source = tableSources[tableIndex];
			const fallback = () => [{ container: root.matches("table") ? root.parentElement ?? root : root, source: { from: starts[source.from], to: Math.min(text.length, starts[source.to] + lines[source.to].length) }, comment }];
			if (!table) return fallback();
			const rowIndex = tableRowIndex(lines, source.from, source.to, comment.lineStart, table.rows.length);
			if (rowIndex === null) return fallback();
			const cells = tableCellRanges(lines[comment.lineStart]), offset = starts[comment.lineStart];
			const column = cells.findIndex((cell) => comment.from >= offset + cell.from && comment.to <= offset + cell.to);
			const row = table.rows[rowIndex];
			if (!row || row.cells.length !== cells.length || column < 0) return fallback();
			const container = row.cells[column];
			if (!container || container.querySelector(".cm-editor")) return [];
			return [{ container, source: { from: offset + cells[column].from, to: offset + cells[column].to }, comment }];
		}
		let first = comment.lineStart, last = comment.lineEnd;
		while (first > lineStart && stripQuote(lines[first - 1]).trim() && !boundary(lines[first])) first--;
		while (last < lineEnd && stripQuote(lines[last + 1]).trim() && !boundary(lines[last + 1])) last++;
		// The empty source-position section is not the rendered definition.
		if (/^[ \t]*\[\^[^\]]+\]:/.test(lines[first])) return [];
		const source = { from: starts[first], to: Math.min(text.length, starts[last] + lines[last].length) };
		const projected = project(withoutComments(text, source, comments), root.ownerDocument).text;
		const matches = candidates.filter((el) => visibleText(el).text === projected && projected.length > 0);
		// Prefer the smallest matching element; identical text in distinct siblings
		// is ambiguous and must not be resolved by choosing the first occurrence.
		const leaves = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
		const byLine = candidates.filter((el) => el.hasAttribute("data-line") && lineStart + Number(el.dataset.line) === first);
		const container = leaves.length === 1 ? leaves[0] : byLine[byLine.length - 1] ?? root;
		return [{ container, source, comment }];
	});
}

/** Only add a span/split a text node. Links, checkboxes, and plugin DOM keep
 * their identity and listeners. Null means a safe end-of-container fallback. */
export function markerPoint(target: MarkerTarget, text: string): Point | null {
	if (text.includes("\u0000")) return null;
	const comments = parseComments(text);
	const actual = comments.find((c) => c.from === target.comment.from && c.to === target.comment.to);
	const source = project(withoutComments(text, target.source, comments, actual), target.container.ownerDocument);
	const dom = visibleText(target.container);
	if (!source.text || source.text !== dom.text) return null;
	let point = dom.before[source.anchor] ?? dom.after[dom.after.length - 1];
	if (!point) return null;
	// A marker next to a link should not become part of its click target.
	const link = point.node.parentElement?.closest("a");
	if (link?.parentNode && point.node.nodeType === 3) {
		const children = Array.from(link.parentNode.childNodes), index = children.indexOf(link);
		if (point.offset === 0 && point.node === link.firstChild) point = { node: link.parentNode, offset: index };
		else if (point.offset === (point.node.textContent?.length ?? 0) && point.node === link.lastChild) point = { node: link.parentNode, offset: index + 1 };
		else return null;
	}
	return point;
}
