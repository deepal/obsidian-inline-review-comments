import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { owningNoteView } from "./editor-host";
import { createInlineAvatar } from "./inline-avatar";
import { markerPoint, markerTargets } from "./marker-anchor";
import type InlineReviewCommentPlugin from "./main";

interface Source { text: string; lineStart: number; lineEnd: number }
interface Block {
	root: HTMLElement;
	source: () => Source | null;
	markers: HTMLElement[];
	observer: MutationObserver | null;
	frame: number | null;
}

/** Ignore only marker DOM, not host cell replacement or text edits. */
function markerMutation(record: MutationRecord): boolean {
	const parent = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
	if (parent?.closest(".irc-inline-avatar")) return true;
	const changed = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
	return record.type === "childList" && changed.length > 0 && changed.every((node) => node.nodeType === 1 && (node as Element).matches(".irc-inline-avatar"));
}

/** Owns spans only; it never rerenders Markdown or changes the note buffer. */
export class RenderedMarkerManager {
	private blocks = new Map<HTMLElement, Block>();
	private pending = new Map<HTMLElement, number>();
	private editors = new Map<() => void, () => void>();
	private destroyed = false;

	constructor(private plugin: InlineReviewCommentPlugin) {}

	handleBlock = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		if (this.destroyed) return;
		const child = new MarkdownRenderChild(el);
		let block: Block | undefined;
		child.onload = () => {
			const previous = this.pending.get(el);
			if (previous !== undefined) el.win.cancelAnimationFrame(previous);
			this.pending.set(el, el.win.requestAnimationFrame(() => {
				this.pending.delete(el);
				if (this.destroyed || !el.isConnected || !el.closest(".markdown-reading-view") || el.closest(".irc-margin-layer, .cm-editor")) return;
				block = this.attach(el, () => ctx.getSectionInfo(el), true);
				this.draw(block);
			}));
		};
		child.onunload = () => {
			const frame = this.pending.get(el);
			if (frame !== undefined) el.win.cancelAnimationFrame(frame);
			this.pending.delete(el);
			if (block && this.blocks.get(el) === block) this.dispose(block);
		};
		ctx.addChild(child);
	};

	/** The full-note editor owns rendered tables and callouts. Cell editors continue
	 * using the normal avatar StateField, with no extra layer or observer. */
	editorExtension() {
		const active = () => !this.destroyed;
		const register = (redraw: () => void, destroy: () => void) => { this.editors.set(redraw, destroy); return () => this.editors.delete(redraw); };
		const remove = (widget: HTMLElement) => { const block = this.blocks.get(widget); if (block) this.dispose(block); };
		const render = (widget: HTMLElement, source: Block["source"]) => {
			const block = this.blocks.get(widget) ?? this.attach(widget, source, false);
			this.draw(block);
		};
		return ViewPlugin.fromClass(class {
			private observer: MutationObserver | null = null;
			private widgets = new Set<HTMLElement>();
			private frame: number | null = null;
			private stopped = false;
			private unregister: () => void;
			private redraw = () => this.schedule();
			constructor(private view: EditorView) {
				this.unregister = register(this.redraw, () => this.destroy());
				this.schedule();
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) this.schedule();
			}
			private schedule() {
				if (this.stopped || !active() || this.frame !== null) return;
				this.frame = this.view.dom.win.requestAnimationFrame(() => { this.frame = null; this.draw(); });
			}
			private draw() {
				if (this.stopped || !active()) return;
				this.observer?.disconnect();
				const next = new Set<HTMLElement>();
				if (owningNoteView(this.view) === this.view) {
					this.observer ??= new (this.view.dom.ownerDocument.defaultView?.MutationObserver ?? MutationObserver)((records) => {
						if (records.some((record) => !markerMutation(record))) this.schedule();
					});
					for (const widget of Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget, .cm-callout"))) {
						if (widget.closest(".cm-editor") !== this.view.dom) continue;
						next.add(widget);
						render(widget, () => {
							try {
								const range = this.view.lineBlockAt(this.view.posAtDOM(widget, 0));
								return { text: this.view.state.doc.toString(), lineStart: this.view.state.doc.lineAt(range.from).number - 1, lineEnd: this.view.state.doc.lineAt(range.to).number - 1 };
							} catch { return null; }
						});
					}
					this.observer.observe(this.view.contentDOM, { childList: true, subtree: true, characterData: true });
				}
				for (const widget of this.widgets) if (!next.has(widget)) {
					remove(widget);
				}
				this.widgets = next;
			}
			destroy() {
				if (this.stopped) return;
				this.stopped = true;
				if (this.frame !== null) this.view.dom.win.cancelAnimationFrame(this.frame);
				this.observer?.disconnect();
				this.unregister();
				for (const widget of this.widgets) {
					remove(widget);
				}
				this.widgets.clear();
			}
		});
	}

	private attach(root: HTMLElement, source: Block["source"], observe: boolean): Block {
		const previous = this.blocks.get(root);
		if (previous) this.dispose(previous);
		const block: Block = { root, source, markers: [], observer: null, frame: null };
		if (observe) block.observer = new (root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver)((records) => {
			if (records.some((record) => !markerMutation(record))) this.schedule(block);
		});
		this.blocks.set(root, block);
		return block;
	}

	private schedule(block: Block): void {
		if (this.destroyed || block.frame !== null) return;
		block.frame = block.root.win.requestAnimationFrame(() => { block.frame = null; this.draw(block); });
	}

	private draw(block: Block): void {
		if (this.destroyed || this.blocks.get(block.root) !== block) return;
		if (!block.root.isConnected) { this.dispose(block); return; }
		block.observer?.disconnect();
		for (const marker of block.markers) marker.remove();
		block.markers = [];
		block.root.classList.remove("irc-rendered-comment-block");
		const source = block.source();
		if (this.plugin.settings.enabled && source) {
			const empty = !block.root.textContent?.trim();
			for (const target of markerTargets(block.root, source.text, source.lineStart, source.lineEnd)) {
				const marker = createInlineAvatar(block.root.ownerDocument, target.comment.author);
				marker.dataset.ircRenderedMarker = target.comment.id ?? `${target.comment.from}:${target.comment.to}`;
				const point = markerPoint(target, source.text);
				if (point) {
					if (point.node.nodeType === 3 && point.offset === 0) point.node.parentNode?.insertBefore(marker, point.node);
					else if (point.node.nodeType === 3 && point.offset === point.node.textContent?.length) point.node.parentNode?.insertBefore(marker, point.node.nextSibling);
					else {
						const range = block.root.ownerDocument.createRange();
						range.setStart(point.node, point.offset); range.collapse(true); range.insertNode(marker);
					}
				} else target.container.appendChild(marker);
				block.markers.push(marker);
			}
			block.root.classList.toggle("irc-rendered-comment-block", empty && block.markers.length > 0);
		}
		block.observer?.observe(block.root, { childList: true, characterData: true, subtree: true });
	}

	refresh(): void {
		for (const block of this.blocks.values()) if (block.observer) this.schedule(block);
		for (const redraw of this.editors.keys()) redraw();
	}

	private dispose(block: Block): void {
		block.observer?.disconnect();
		if (block.frame !== null) block.root.win.cancelAnimationFrame(block.frame);
		for (const marker of block.markers) marker.remove();
		block.root.classList.remove("irc-rendered-comment-block");
		if (this.blocks.get(block.root) === block) this.blocks.delete(block.root);
	}

	destroy(): void {
		this.destroyed = true;
		for (const [el, frame] of this.pending) el.win.cancelAnimationFrame(frame);
		this.pending.clear();
		for (const stop of this.editors.values()) stop();
		for (const block of this.blocks.values()) this.dispose(block);
		this.editors.clear();
	}
}
