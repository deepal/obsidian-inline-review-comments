import { MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile } from "obsidian";
import { renderCommentBody } from "./render";
import { groupComments, parseComments, ParsedComment } from "./parser";
import {
	findRemovalRange,
	findCommentEnd,
	findThreadRange,
	replyMarkdown,
} from "./comment-edit";
import { CardLayer, AnchorItem } from "./card-layer";
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
		child.onload = () => {
			frame = el.win.requestAnimationFrame(() => {
				frame = undefined;
				if (this.destroyed || !el.isConnected) return;
				const wrapper = el.closest<HTMLElement>(".markdown-reading-view");
				const scroller = el.closest<HTMLElement>(".markdown-preview-view");
				if (!wrapper || !scroller) return;
				const state = this.ensureState(wrapper, scroller);
				state.text = info.text;
				state.sourcePath = ctx.sourcePath;
				this.schedule(state);
			});
		};
		child.onunload = () => {
			if (frame !== undefined) el.win.cancelAnimationFrame(frame);
		};
		ctx.addChild(child);
	};

	private ensureState(wrapper: HTMLElement, scroller: HTMLElement): ReadingLayerState {
		let state = this.states.get(wrapper);
		if (state) return state;

		// Append to the scroller so cards scroll natively with the content.
		const layer = new CardLayer(scroller, this.plugin.settings.cardWidth);
		const onScroll = () => state && this.draw(state);
		const resizeObserver = new ResizeObserver(() => state && this.draw(state));

		state = {
			wrapper,
			scroller,
			layer,
			text: "",
			sourcePath: "",
			frame: null,
			onScroll,
			resizeObserver,
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

		state.layer.setWidth(this.plugin.settings.cardWidth);

		if (!this.plugin.settings.enabled) {
			state.layer.clear();
			state.scroller.classList.remove("irc-has-comments");
			return;
		}

		const comments = parseComments(state.text);
		// Reserve a right gutter (via CSS) only when the note has comments.
		state.scroller.classList.toggle("irc-has-comments", comments.length > 0);
		const blocks = this.collectBlocks(state.scroller);
		// Content coordinates (scroll-independent) so the layer scrolls natively.
		const scrollerTop = state.scroller.getBoundingClientRect().top;
		const scrollOffset = state.scroller.scrollTop;

		const items: AnchorItem[] = [];
		for (const thread of groupComments(comments, state.text)) {
			const block = this.blockForLine(blocks, thread[0].lineStart);
			if (!block) continue;
			const top =
				block.el.getBoundingClientRect().top - scrollerTop + scrollOffset;
			items.push({ thread, top });
		}

		state.layer.render(items, {
			onDelete: (c) => {
				void this.deleteComment(state, c).catch(() => new Notice("Could not save the comment change."));
			},
			onReply: (thread, text) => {
				void this.reply(state, thread, text).catch(() => new Notice("Could not save the comment change."));
			},
			onResolve: (thread) => {
				void this.resolveThread(state, thread).catch(() => new Notice("Could not save the comment change."));
			},
			renderBody: (el, md) =>
				renderCommentBody(this.plugin.app, this.plugin, el, md, state.sourcePath),
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
	): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(state.sourcePath);
		if (!(file instanceof TFile)) return;
		await this.plugin.app.vault.process(file, (data) => {
			const end = findCommentEnd(data, thread[thread.length - 1]);
			if (end == null) return data;
			const insert = replyMarkdown(this.plugin.settings.username, text);
			return data.slice(0, end) + insert + data.slice(end);
		});
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
		state.layer.destroy();
		state.scroller.classList.remove("irc-has-comments");
		this.states.delete(state.wrapper);
	}

	destroy(): void {
		this.destroyed = true;
		for (const state of [...this.states.values()]) this.disposeState(state);
	}
}
