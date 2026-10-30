import { initials, colorForName } from "./card";

/** Shared presentation; always create nodes in the owning pane's document. */
export function createInlineAvatar(doc: Document, author: string | null): HTMLElement {
	const span = doc.defaultView!.createSpan();
	span.className = "irc-inline-avatar";
	const label = author ? `Comment by ${author}` : "Comment";
	span.setAttribute("aria-label", label);
	span.setAttribute("role", "img");
	span.setAttribute("title", label);
	if (author) {
		const inner = span.createSpan();
		inner.className = "irc-inline-avatar-initials";
		inner.textContent = initials(author);
		inner.setAttribute("aria-hidden", "true");
		span.style.backgroundColor = colorForName(author);
	} else span.classList.add("irc-inline-avatar-anon");
	return span;
}
