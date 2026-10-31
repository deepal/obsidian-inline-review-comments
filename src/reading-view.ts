import { MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile } from "obsidian";
import { renderCommentBody } from "./render";
import { encodeComment } from "./comment-context";
import { groupComments, parseComments, ParsedComment } from "./parser";
import {
	findRemovalRange,
	findReplyEnd,
	findThreadRange,
	commentMarkdown,
	initialCommentChange,
	editCommentChange,
} from "./comment-edit";
import { CardLayer, AnchorItem } from "./card-layer";
import { tableRowForLine, TableResizeObserver } from "./table-anchor";
import { applyMargin, computeMarginLayout, measureMargin } from "./margin-geometry";
import type InlineReviewCommentPlugin from "./main";

interface ReadingLayerState {
	wrapper: HTMLElement; // .markdown-reading-view (non-scrolling)
	scroller: HTMLElement; // .markdown-preview-view (scrolls)
	layer: CardLayer;
	text: string;
	sourcePath: string;
	frame: number | null;
	onScroll: () => void;
	resizeObserver: ResizeObserver;
	/** The `.markdown-preview-sizer` currently watched by `resizeObserver`. */
	sizer: HTMLElement | null;
	tables: TableResizeObserver;
}

/**
 * Renders review cards in Reading view. Driven by a markdown post-processor:
 * each rendered top-level block is stamped with its source line range, and the
 * full document text is taken from `getSectionInfo().text`. Cards are aligned
 * to the block that contains (or precedes) each comment's line.
 */
export class ReadingViewManager {
	private plugin: InlineReviewCommentPlugin;
	private states = new Map<HTMLElement, ReadingLayerState>();
	private destroyed = false;

	constructor(plugin: InlineReviewCommentPlugin) {
		this.plugin = plugin;
	}

	/** Markdown post-processor entry point — registered in main.ts. */
	handleBlock = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const info = ctx.getSectionInfo(el);
		if (!info) return;

		el.dataset.ircLineStart = String(info.lineStart);
		el.dataset.ircLineEnd = String(info.lineEnd);

		// Post-processors can run while the block is detached. Wait until its
		// render component loads, then locate the owning view on the next frame.
		const child = new MarkdownRenderChild(el);
		let frame: number | undefined;
		let attachedWrapper: HTMLElement | null = null;
		child.onload = () => {
			frame = el.win.requestAnimationFrame(() => {
				frame = undefined;
				if (this.destroyed || !el.isConnected) return;
				const wrapper = el.closest<HTMLElement>(".markdown-reading-view");
				const scroller = el.closest<HTMLElement>(".markdown-preview-view");
				if (!wrapper || !scroller) return;
				attachedWrapper = wrapper;
				const state = this.ensureState(wrapper, scroller);
				state.text = info.text;
				state.sourcePath = ctx.sourcePath;
				this.schedule(state);
			});
		};
		child.onunload = () => {
			if (frame !== undefined) el.win.cancelAnimationFrame(frame);
			// Removing a tab need not produce another scroll/render. Release its
			// card scopes and observers after Obsidian detaches the preview DOM.
			queueMicrotask(() => {
				if (!attachedWrapper || attachedWrapper.isConnected) return;
				const state = this.states.get(attachedWrapper);
				if (state) this.disposeState(state);
			});
		};
		ctx.addChild(child);
	};

	private ensureState(wrapper: HTMLElement, scroller: HTMLElement): ReadingLayerState {
		let state = this.states.get(wrapper);
		if (state) return state;

		// Append to the scroller so cards scroll natively with the content.
		const layer = new CardLayer(scroller, this.plugin.settings.cardWidth);
		const onScroll = () => state && this.draw(state);
		const resizeObserver = new ResizeObserver(() => state && this.schedule(state));
		const tables = new TableResizeObserver(() => state && this.schedule(state));

		state = {
			wrapper,
			scroller,
			layer,
			text: "",
			sourcePath: "",
			frame: null,
			onScroll,
			resizeObserver,
			sizer: null,
			tables,
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		resizeObserver.observe(scroller);
		this.states.set(wrapper, state);
		return state;
	}

	private schedule(state: ReadingLayerState): void {
		if (state.frame !== null) return;
		state.frame = state.scroller.win.requestAnimationFrame(() => {
			state.frame = null;
			if (!this.destroyed && this.states.get(state.wrapper) === state) this.draw(state);
		});
	}

	private draw(state: ReadingLayerState): void {
		if (!state.wrapper.isConnected) {
			this.disposeState(state);
			return;
		}

		if (!this.plugin.settings.enabled) {
			state.layer.clear();
			state.tables.update([]);
			state.scroller.classList.remove("irc-has-comments");
			applyMargin(state.scroller, null);
			return;
		}

		const comments = parseComments(state.text);
		this.plugin.drafts.observe(state.sourcePath, state.text);
		// Measure before toggling the gutter class, which changes the column.
		const sizer = state.scroller.querySelector<HTMLElement>(".markdown-preview-sizer");
		const margin = computeMarginLayout(measureMargin(state.scroller, sizer, this.plugin.settings.cardWidth));
		// Reserve a right gutter (via CSS) only when the note has comments.
		state.scroller.classList.toggle("irc-has-comments", comments.length > 0);
		applyMargin(state.scroller, comments.length > 0 ? margin : null);
		state.layer.setWidth(margin.cardWidth);
		state.layer.setLeft(margin.cardLeft);
		// Toggling readable line length resizes the sizer but not the scroller.
		// Re-observing an element re-fires the observer, so only observe a new one.
		if (sizer !== state.sizer) {
			if (state.sizer) state.resizeObserver.unobserve(state.sizer);
			if (sizer) state.resizeObserver.observe(sizer);
			state.sizer = sizer;
		}
		const blocks = this.collectBlocks(state.scroller);
		const lines = state.text.split("\n");
		state.tables.update(Array.from(state.scroller.querySelectorAll<HTMLTableElement>("table")));
		// Content coordinates (scroll-independent) so the layer scrolls natively.
		const scrollerTop = state.scroller.getBoundingClientRect().top;
		const scrollOffset = state.scroller.scrollTop;

		const items: AnchorItem[] = [];
		for (const thread of groupComments(comments, state.text)) {
			const block = this.blockForLine(blocks, thread[0].lineStart);
			if (!block) continue;
			const tables = block.el.instanceOf(HTMLTableElement) ? [block.el] : Array.from(block.el.querySelectorAll<HTMLTableElement>("table"));
			const row = tables.length === 1 ? tableRowForLine(tables[0], lines, block.lineStart, block.lineEnd, thread[0].lineStart) : null;
			const top = (row ?? block.el).getBoundingClientRect().top - scrollerTop + scrollOffset;
			items.push({ thread, top });
		}

		state.layer.render(items, {
			app: this.plugin.app,
			drafts: this.plugin.drafts,
			sourcePath: state.sourcePath,
			onEscape: () => {
				state.scroller.setAttribute("tabindex", "-1");
				state.scroller.focus();
			},
			bindStatus: (card, thread, owner, replyBox) => {
				const ids = thread.map((c) => c.id ?? null);
				this.plugin.mentions.bind(card, state.sourcePath, ids, owner, () => this.schedule(state), replyBox);
				this.plugin.mentions.bindComposer(replyBox, state.sourcePath, ids, owner);
			},
			onDelete: (c) => {
				void this.deleteComment(state, c).catch(() => new Notice("Could not save the comment change."));
			},
			onReply: (thread, text) => this.reply(state, thread, text),
			onPost: (comment, text) => this.write(state, (data) => initialCommentChange(data, comment, text)),
			onEdit: (comment, text) => this.write(state, (data) => editCommentChange(data, comment, text), false),
			onResolve: (thread) => {
				void this.resolveThread(state, thread).catch(() => new Notice("Could not save the comment change."));
			},
			renderBody: (el, md, owner = this.plugin) => this.plugin.mentions.bindBody(owner, (tag) => {
				el.empty();
				renderCommentBody(this.plugin.app, owner, el, md, state.sourcePath, tag);
			}),
		});
	}

	private collectBlocks(
		scroller: HTMLElement
	): Array<{ el: HTMLElement; lineStart: number; lineEnd: number }> {
		const els = scroller.querySelectorAll<HTMLElement>("[data-irc-line-start]");
		const blocks: Array<{ el: HTMLElement; lineStart: number; lineEnd: number }> = [];
		els.forEach((el) => {
			blocks.push({
				el,
				lineStart: Number(el.dataset.ircLineStart),
				lineEnd: Number(el.dataset.ircLineEnd),
			});
		});
		blocks.sort((a, b) => a.lineStart - b.lineStart);
		return blocks;
	}

	/** Block containing the line, else the nearest preceding block, else first. */
	private blockForLine(
		blocks: Array<{ el: HTMLElement; lineStart: number; lineEnd: number }>,
		line: number
	): { el: HTMLElement; lineStart: number; lineEnd: number } | null {
		if (blocks.length === 0) return null;
		let best: (typeof blocks)[number] | null = null;
		for (const b of blocks) {
			if (line >= b.lineStart && line <= b.lineEnd) return b;
			if (b.lineStart <= line) best = b;
		}
		return best ?? blocks[0];
	}

	private async deleteComment(
		state: ReadingLayerState,
		comment: ParsedComment
	): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(state.sourcePath);
		if (!(file instanceof TFile)) return;
		await this.plugin.app.vault.process(file, (data) => {
			const range = findRemovalRange(data, comment);
			if (!range) return data;
			return data.slice(0, range.from) + data.slice(range.to);
		});
	}

	private async reply(
		state: ReadingLayerState,
		thread: ParsedComment[],
		text: string
	): Promise<boolean> {
		return this.write(state, (data) => {
			const end = findReplyEnd(data, thread);
			return end == null ? null : { from: end, to: end, insert: encodeComment(data, end, ` ${commentMarkdown(this.plugin.settings.username, text, null, crypto.randomUUID())}`) };
		});
	}

	private async write(state: ReadingLayerState, change: (data: string) => { from: number; to: number; insert: string } | null, submitMentions = true): Promise<boolean> {
		const file = this.plugin.app.vault.getAbstractFileByPath(state.sourcePath);
		if (!(file instanceof TFile)) return false;
		let before = "";
		let after = "";
		let accepted = false;
		await this.plugin.app.vault.process(file, (data) => {
			before = after = data;
			const edit = change(data);
			if (!edit) return data;
			accepted = true;
			after = data.slice(0, edit.from) + edit.insert + data.slice(edit.to);
			return after;
		});
		if (!accepted) return false;
		if (before === after) return true;
		state.text = after;
		this.schedule(state);
		if (submitMentions) this.plugin.mentions.committed(state.sourcePath, before, after);
		else this.plugin.mentions.changed(state.sourcePath);
		return true;
	}

	private async resolveThread(
		state: ReadingLayerState,
		thread: ParsedComment[]
	): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(state.sourcePath);
		if (!(file instanceof TFile)) return;
		await this.plugin.app.vault.process(file, (data) => {
			const range = findThreadRange(data, thread);
			if (!range) return data;
			return data.slice(0, range.from) + data.slice(range.to);
		});
	}

	/** Forces a redraw of all live reading views (e.g. after a settings change). */
	refresh(): void {
		for (const state of this.states.values()) this.draw(state);
	}

	private disposeState(state: ReadingLayerState): void {
		if (state.frame !== null) state.scroller.win.cancelAnimationFrame(state.frame);
		state.frame = null;
		state.scroller.removeEventListener("scroll", state.onScroll);
		state.resizeObserver.disconnect();
		state.tables.destroy();
		state.layer.destroy();
		state.scroller.classList.remove("irc-has-comments");
		applyMargin(state.scroller, null);
		this.states.delete(state.wrapper);
	}

	destroy(): void {
		this.destroyed = true;
		for (const state of [...this.states.values()]) this.disposeState(state);
	}
}
