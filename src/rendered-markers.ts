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
	removeMarkers: Array<() => void>;
	observer: MutationObserver | null;
	frame: number | null;
	readingRoot?: HTMLElement;
}
interface ReadingRoot { root: HTMLElement; observer: MutationObserver; frame: number | null }

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
	private readingPending = new Map<HTMLElement, Block["source"]>();
	private readingSources = new WeakMap<HTMLElement, Block["source"]>();
	private readingRoots = new Map<HTMLElement, ReadingRoot>();
	private editors = new Map<() => void, () => void>();
	private destroyed = false;

	constructor(private plugin: InlineReviewCommentPlugin) {}

	handleBlock = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		if (this.destroyed) return;
		const child = new MarkdownRenderChild(el);
		const source = () => ctx.getSectionInfo(el);
		this.readingSources.set(el, source);
		child.onload = () => {
			if (this.destroyed) return;
			// Preview virtualization can load a cached section before attaching
			// its DOM. Retain its source until the owning preview inserts it.
			this.readingPending.set(el, source);
			const previous = this.pending.get(el);
			if (previous !== undefined) el.win.cancelAnimationFrame(previous);
			this.pending.set(el, el.win.requestAnimationFrame(() => {
				this.pending.delete(el);
				this.attachReading(el);
			}));
		};
		child.onunload = () => {
			const frame = this.pending.get(el);
			if (frame !== undefined) el.win.cancelAnimationFrame(frame);
			this.pending.delete(el);
			if (this.readingPending.get(el) === source) this.readingPending.delete(el);
			const block = this.blocks.get(el);
			if (block?.source === source) this.dispose(block);
			queueMicrotask(() => {
				for (const state of this.readingRoots.values()) if (!state.root.isConnected) this.disposeReadingRoot(state);
			});
		};
		ctx.addChild(child);
	};

	private attachReading(el: HTMLElement): Block | undefined {
		if (this.destroyed || !el.isConnected || !el.closest(".markdown-reading-view") || el.closest(".irc-margin-layer, .cm-editor")) return;
		const source = this.readingPending.get(el);
		const root = el.closest<HTMLElement>(".markdown-preview-view");
		if (!source || !root) return;
		if (!this.readingRoots.has(root)) {
			const state: ReadingRoot = { root, frame: null, observer: new root.ownerDocument.defaultView!.MutationObserver((records) => {
				if (records.every(markerMutation)) return;
				// Cached preview DOM may return without another child onload.
				// Weak source associations survive that cache without retaining
				// discarded sections for the lifetime of the view.
				for (const record of records) for (const node of Array.from(record.addedNodes)) {
					if (node.nodeType !== 1) continue;
					const element = node as HTMLElement;
					for (const section of [element, ...Array.from(element.querySelectorAll<HTMLElement>("*"))]) {
						const source = this.readingSources.get(section);
						if (source && !this.blocks.has(section)) this.readingPending.set(section, source);
					}
				}
				if (!this.readingPending.size || state.frame !== null) return;
				state.frame = root.win.requestAnimationFrame(() => {
					state.frame = null;
					if (this.destroyed || !root.isConnected) { this.disposeReadingRoot(state); return; }
					for (const section of this.readingPending.keys()) if (root.contains(section)) this.attachReading(section);
				});
			}) };
			this.readingRoots.set(root, state);
			state.observer.observe(root, { childList: true, subtree: true });
		}
		this.readingPending.delete(el);
		const block = this.attach(el, source, true);
		block.readingRoot = root;
		this.draw(block);
		return block;
	}

	private disposeReadingRoot(state: ReadingRoot): void {
		state.observer.disconnect();
		if (state.frame !== null) state.root.win.cancelAnimationFrame(state.frame);
		this.readingRoots.delete(state.root);
		for (const block of this.blocks.values()) if (block.readingRoot === state.root) this.dispose(block);
	}

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
		const block: Block = { root, source, removeMarkers: [], observer: null, frame: null };
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
		for (const remove of block.removeMarkers) remove();
		block.removeMarkers = [];
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
				const unbind = this.plugin.gravatar?.bind(marker, target.comment.author);
				block.removeMarkers.push(() => {
					unbind?.();
					marker.remove();
				});
			}
			block.root.classList.toggle("irc-rendered-comment-block", empty && block.removeMarkers.length > 0);
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
		for (const remove of block.removeMarkers) remove();
		block.root.classList.remove("irc-rendered-comment-block");
		if (this.blocks.get(block.root) === block) this.blocks.delete(block.root);
	}

	destroy(): void {
		this.destroyed = true;
		for (const [el, frame] of this.pending) el.win.cancelAnimationFrame(frame);
		this.pending.clear();
		this.readingPending.clear();
		this.readingSources = new WeakMap();
		for (const state of this.readingRoots.values()) this.disposeReadingRoot(state);
		for (const stop of this.editors.values()) stop();
		for (const block of this.blocks.values()) this.dispose(block);
		this.editors.clear();
	}
}
