import { Component } from "obsidian";
import { buildCard, CardCallbacks } from "./card";
import { ParsedComment } from "./parser";

export interface AnchorItem {
	/** One or more back-to-back comments rendered as a single threaded card. */
	thread: ParsedComment[];
	/** Desired top, in pixels relative to the layer element. */
	top: number;
}

/** Vertical gap kept between stacked cards. */
const STACK_GAP = 8;

/**
 * Owns the absolutely-positioned `.irc-margin-layer` element and the review
 * cards inside it. Reconciles cards across updates (so scrolling doesn't
 * rebuild the DOM) and stacks them so they never overlap.
 */
export class CardLayer {
	readonly el: HTMLElement;
	private ownsPositioning = false;
	private cards = new Map<string, HTMLElement>();
	private owners = new Map<string, Component>();
	private layoutItems: Array<{ key: string; top: number }> = [];
	private resizeObserver: ResizeObserver;
	private readonly previousWidth: string;
	private readonly previousWidthPriority: string;
	private width = "";

	constructor(private readonly parent: HTMLElement, widthPx: number) {
		this.previousWidth = parent.style.getPropertyValue("--irc-card-width");
		this.previousWidthPriority = parent.style.getPropertyPriority("--irc-card-width");
		// The layer is an absolutely-positioned child of the scroll container so
		// it scrolls natively with the content. That requires the scroller to be
		// a positioning context; make it one if it isn't (relative without
		// offsets doesn't change layout).
		if (parent.win.getComputedStyle(parent).position === "static") {
			parent.classList.add("irc-positioned-container");
			this.ownsPositioning = true;
		}
		this.el = parent.createDiv({ cls: "irc-margin-layer" });
		this.resizeObserver = new ResizeObserver(() => this.layout());
		this.setWidth(widthPx);
	}

	setWidth(widthPx: number): void {
		this.width = `${widthPx}px`;
		// The writing column is a sibling of the layer, so both must inherit
		// the width from their shared scroller for the gutter to track settings.
		this.parent.style.setProperty("--irc-card-width", this.width);
		this.el.style.setProperty("--irc-card-width", this.width);
	}

	private static key(thread: ParsedComment[]): string {
		return JSON.stringify(thread.map((c) => [c.from, c.author, c.body, c.quote, c.id]));
	}

	/** Reconciles cards to `items`, then positions them with collision avoidance. */
	render(items: AnchorItem[], cb: CardCallbacks): void {
		const doc = this.el.ownerDocument;
		const focused = doc.activeElement;
		const input = focused?.tagName === "TEXTAREA" && this.el.contains(focused) ? focused as HTMLTextAreaElement : null;
		const focusKey = input?.closest<HTMLElement>("[data-irc-composer-key]")?.dataset.ircComposerKey;
		const selection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
		const itemKey = (thread: ParsedComment[]) => JSON.stringify([cb.sourcePath, CardLayer.key(thread)]);
		const seen = new Set<string>();

		for (const item of items) {
			const key = itemKey(item.thread);
			seen.add(key);
			if (!this.cards.has(key)) {
				const owner = new Component();
				owner.load();
				this.owners.set(key, owner);
				const card = buildCard(item.thread, cb, owner);
				this.el.appendChild(card);
				this.resizeObserver.observe(card);
				this.cards.set(key, card);
			}
		}

		// Drop cards that are no longer present.
		for (const [key, card] of this.cards) {
			if (!seen.has(key)) {
				this.resizeObserver.unobserve(card);
				card.remove();
				this.owners.get(key)?.unload();
				this.owners.delete(key);
				this.cards.delete(key);
			}
		}

		this.layoutItems = items.map((item) => ({ key: itemKey(item.thread), top: item.top }));
		this.layout();
		if (focusKey && input && !input.isConnected) {
			const replacement = Array.from(this.el.querySelectorAll<HTMLElement>("[data-irc-composer-key]")).find((el) => el.dataset.ircComposerKey === focusKey)?.querySelector("textarea");
			queueMicrotask(() => {
				if (!replacement?.isConnected || (doc.activeElement !== doc.body && doc.activeElement !== input)) return;
				replacement.focus({ preventScroll: true });
				if (selection) replacement.setSelectionRange(...selection);
			});
		}
	}

	/** Re-stack after async Markdown rendering or a user resizing a textarea. */
	private layout(): void {
		let prevBottom = -Infinity;
		for (const item of [...this.layoutItems].sort((a, b) => a.top - b.top)) {
			const card = this.cards.get(item.key);
			if (!card) continue;
			const top = Math.max(item.top, prevBottom + STACK_GAP);
			card.style.top = `${top}px`;
			prevBottom = top + card.offsetHeight;
		}
	}

	clear(): void {
		this.layoutItems = [];
		for (const owner of this.owners.values()) owner.unload();
		this.owners.clear();
		for (const card of this.cards.values()) card.remove();
		this.resizeObserver.disconnect();
		this.cards.clear();
	}

	destroy(): void {
		this.clear();
		this.el.remove();
		if (this.parent.style.getPropertyValue("--irc-card-width") === this.width && !this.parent.style.getPropertyPriority("--irc-card-width")) {
			if (this.previousWidth) this.parent.style.setProperty("--irc-card-width", this.previousWidth, this.previousWidthPriority);
			else this.parent.style.removeProperty("--irc-card-width");
		}
		if (this.ownsPositioning) this.parent.classList.remove("irc-positioned-container");
	}
}
