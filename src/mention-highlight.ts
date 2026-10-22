import { mentionRanges } from "./agent-bridge.ts";

/** Only validated name tokens become markup; note content is never changed. */
export function highlightMentionMarkdown(body: string, tag: string): string {
	let result = "", from = 0;
	for (const range of mentionRanges(body, tag)) {
		result += body.slice(from, range.from) + `<span class="aio-mention-tag">${body.slice(range.from, range.to)}</span>`;
		from = range.to;
	}
	return result + body.slice(from);
}

export function highlightMentionText(el: HTMLElement, body: string, tag: string): void {
	const ranges = mentionRanges(body, tag);
	if (!ranges.length) { el.setText(body); return; }
	el.empty();
	let from = 0;
	for (const range of ranges) {
		el.append(el.ownerDocument.createTextNode(body.slice(from, range.from)));
		el.createSpan({ cls: "aio-mention-tag", text: body.slice(range.from, range.to) });
		from = range.to;
	}
	el.append(el.ownerDocument.createTextNode(body.slice(from)));
}
