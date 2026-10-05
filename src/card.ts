import { setIcon } from "obsidian";
import { ParsedComment } from "./parser";

export interface CardCallbacks {
	/** Invoked when the user clicks a message's delete (`×`) button. */
	onDelete: (comment: ParsedComment) => void;
	/** Invoked when the user sends a reply; `text` is the typed message body. */
	onReply: (thread: ParsedComment[], text: string) => void;
	/** Invoked when the user resolves the thread (deletes all its comments). */
	onResolve: (thread: ParsedComment[]) => void;
	/** Renders `markdown` into `el` (e.g. via Obsidian's MarkdownRenderer). */
	renderBody: (el: HTMLElement, markdown: string) => void;
}

/**
 * Builds a read-only review card for a thread of one or more comments. Each
 * comment renders as a message (author + body + its own delete button); a
 * multi-comment thread stacks them with dividers, like a Google Docs thread.
 * Editing is done in the editor inside the `%% %%`, never on the card.
 */
export function buildCard(thread: ParsedComment[], cb: CardCallbacks): HTMLElement {
	const card = createDiv({ cls: "irc-card" });
	if (thread.length > 1) card.addClass("irc-thread");

	thread.forEach((comment, i) => {
		const message = card.createDiv({ cls: "irc-message" });

		const header = message.createDiv({ cls: "irc-card-header" });
		const author = header.createDiv({ cls: "irc-author" });
		if (comment.author) {
			const avatar = author.createSpan({ cls: "irc-avatar", text: initials(comment.author) });
			avatar.style.backgroundColor = colorForName(comment.author);
			author.createSpan({ cls: "irc-author-name", text: comment.author });
		} else {
			author.createSpan({ cls: "irc-author-name irc-author-anon", text: "Comment" });
		}

		// Resolve (whole thread) lives in the first message's header — no extra row.
		if (i === 0) {
			const resolve = header.createEl("button", {
				cls: "irc-resolve",
				attr: { "aria-label": "Resolve thread", type: "button" },
			});
			setIcon(resolve, "check");
			resolve.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				cb.onResolve(thread);
			});
		}

		const del = header.createEl("button", {
			cls: "irc-delete",
			attr: { "aria-label": "Delete comment", type: "button" },
		});
		setIcon(del, "x");
		del.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			cb.onDelete(comment);
		});

		if (comment.quote) {
			// Show the excerpt verbatim rather than as markdown: a quoted heading
			// would otherwise render as oversized text and swamp the card.
			const quote = message.createDiv({ cls: "irc-quote" });
			quote.setText(comment.quote);
		}

		const body = message.createDiv({ cls: "irc-body" });
		const text = comment.body.trim();
		if (text) cb.renderBody(body, text);
		else if (!comment.quote) body.setText("(Empty comment)");
	});

	buildReplyBox(card, thread, cb);
	return card;
}

/** A "Reply…" composer at the bottom of the card; Enter (or the button) sends. */
function buildReplyBox(card: HTMLElement, thread: ParsedComment[], cb: CardCallbacks): void {
	const box = card.createDiv({ cls: "irc-reply" });
	const input = box.createEl("textarea", {
		cls: "irc-reply-input",
		attr: { rows: "1", placeholder: "Reply…" },
	});
	const send = box.createEl("button", {
		cls: "irc-reply-send",
		attr: { "aria-label": "Send reply", type: "button" },
	});
	setIcon(send, "send-horizontal");

	const submit = () => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		cb.onReply(thread, text);
	};

	send.addEventListener("click", (e) => {
		e.preventDefault();
		submit();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	});
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A stable avatar colour derived from a name: the same name always maps to the
 * same hue, different names spread across the wheel. Mid lightness/saturation
 * keeps white initials readable in both light and dark themes.
 */
export function colorForName(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 60%, 45%)`;
}
