import { highlightMentionMarkdown } from "./mention-highlight.ts";
import { App, Component, MarkdownRenderer, Notice } from "obsidian";

const generations = new WeakMap<HTMLElement, number>();
const linked = new WeakSet<HTMLElement>();

/**
 * Renders `markdown` into `el` and wires anchor clicks. Links inside a comment
 * card don't navigate on their own (the card sits inside the editor scroller /
 * reading-view overlay, outside Obsidian's normal link handling), so we
 * intercept clicks and route them: internal links via `openLinkText`, external
 * links to the system browser. Delegation on `el` covers links added by the
 * async render.
 */
export function renderCommentBody(
	app: App,
	component: Component,
	el: HTMLElement,
	markdown: string,
	sourcePath: string,
	tag = ""
): void {
	const generation = (generations.get(el) ?? 0) + 1;
	generations.set(el, generation);
	if (tag) {
		const rendered = createDiv();
		void MarkdownRenderer.render(app, highlightMentionMarkdown(markdown, tag), rendered, sourcePath, component).then(() => {
			if (generations.get(el) === generation) el.replaceChildren(...Array.from(rendered.childNodes));
		});
	} else {
		void MarkdownRenderer.render(app, markdown, el, sourcePath, component);
	}
	if (linked.has(el)) return;
	linked.add(el);

	el.addEventListener("click", (evt) => {
		const anchor = (evt.target as HTMLElement).closest("a");
		if (!anchor) return;

		evt.preventDefault();
		evt.stopPropagation();

		const newLeaf = evt.metaKey || evt.ctrlKey;
		if (anchor.classList.contains("internal-link")) {
			const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			if (href) void app.workspace.openLinkText(href, sourcePath, newLeaf).catch(() => {
				new Notice("Could not open the linked note.");
			});
		} else {
			const href = anchor.getAttribute("href");
			if (href) window.open(href, "_blank");
		}
	});
}
