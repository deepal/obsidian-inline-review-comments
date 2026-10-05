import { App, Component, MarkdownRenderer } from "obsidian";

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
	sourcePath: string
): void {
	void MarkdownRenderer.render(app, markdown, el, sourcePath, component);

	el.addEventListener("click", (evt) => {
		const anchor = (evt.target as HTMLElement).closest("a");
		if (!anchor) return;

		evt.preventDefault();
		evt.stopPropagation();

		const newLeaf = evt.metaKey || evt.ctrlKey;
		if (anchor.classList.contains("internal-link")) {
			const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			if (href) app.workspace.openLinkText(href, sourcePath, newLeaf);
		} else {
			const href = anchor.getAttribute("href");
			if (href) window.open(href, "_blank");
		}
	});
}
