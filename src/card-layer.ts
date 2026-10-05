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
	private cards = new Map<string, HTMLElement>();

	constructor(parent: HTMLElement, widthPx: number) {
		// The layer is an absolutely-positioned child of the scroll container so
		// it scrolls natively with the content. That requires the scroller to be
		// a positioning context; make it one if it isn't (relative without
		// offsets doesn't change layout).
		if (getComputedStyle(parent).position === "static") {
			parent.style.position = "relative";
		}
		this.el = parent.createDiv({ cls: "irc-margin-layer" });
		this.setWidth(widthPx);
	}

	setWidth(widthPx: number): void {
		this.el.style.setProperty("--irc-card-width", `${widthPx}px`);
	}

	private static key(thread: ParsedComment[]): string {
		return thread.map((c) => `${c.from}|${c.author ?? ""}|${c.body}`).join("¦");
	}

	/** Reconciles cards to `items`, then positions them with collision avoidance. */
	render(items: AnchorItem[], cb: CardCallbacks): void {
		const seen = new Set<string>();

		for (const item of items) {
			const key = CardLayer.key(item.thread);
			seen.add(key);
			if (!this.cards.has(key)) {
				const card = buildCard(item.thread, cb);
				this.el.appendChild(card);
				this.cards.set(key, card);
			}
		}

		// Drop cards that are no longer present.
		for (const [key, card] of this.cards) {
			if (!seen.has(key)) {
				card.remove();
				this.cards.delete(key);
			}
		}

		// Stack: sort by desired top, push each down past the previous card.
		const ordered = [...items].sort((a, b) => a.top - b.top);
		let prevBottom = -Infinity;
		for (const item of ordered) {
			const card = this.cards.get(CardLayer.key(item.thread));
			if (!card) continue;
			const top = Math.max(item.top, prevBottom + STACK_GAP);
			card.style.top = `${top}px`;
			prevBottom = top + card.offsetHeight;
		}
	}

	clear(): void {
		for (const card of this.cards.values()) card.remove();
		this.cards.clear();
	}

	destroy(): void {
		this.clear();
		this.el.remove();
	}
}
