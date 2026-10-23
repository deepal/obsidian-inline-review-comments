import { App, Component, setIcon } from "obsidian";
import { ParsedComment } from "./parser";
import { buildComposer } from "./composer";
import type { DraftStore } from "./drafts";

export interface CardCallbacks {
	app: App;
	drafts: DraftStore;
	sourcePath: string;
	onEscape: () => void;
	bindStatus?: (card: HTMLElement, thread: ParsedComment[], owner: Component, replyBox: HTMLElement) => void;
	/** Invoked when the user clicks a message's delete (`×`) button. */
	onDelete: (comment: ParsedComment) => void;
	/** Invoked when the user sends a reply; `text` is the typed message body. */
	onReply: (thread: ParsedComment[], text: string) => Promise<boolean>;
	onPost: (comment: ParsedComment, text: string) => Promise<boolean>;
	onEdit: (comment: ParsedComment, text: string) => Promise<boolean>;
	/** Invoked when the user resolves the thread (deletes all its comments). */
	onResolve: (thread: ParsedComment[]) => void;
	/** Renders `markdown` into `el` (e.g. via Obsidian's MarkdownRenderer). */
	renderBody: (el: HTMLElement, markdown: string, owner?: Component) => void;
}

/**
 * Builds a review card for a thread of one or more comments. Each
 * comment renders as a message (author + body + its own delete button); a
 * multi-comment thread stacks them with dividers, like a Google Docs thread.
 * New comments and edits use composers; Escape returns to the note without discarding drafts.
 */
export function buildCard(thread: ParsedComment[], cb: CardCallbacks, owner: Component): HTMLElement {
	const card = createDiv({ cls: "irc-card" });
	if (thread.length > 1) card.addClass("irc-thread");
	let initialBox: HTMLElement | undefined;

	thread.forEach((comment, i) => {
		const message = card.createDiv({ cls: "irc-message" });
		if (comment.id) message.dataset.ircCommentId = comment.id;
		const draft = cb.drafts.initial(cb.sourcePath, comment);
		const editDraft = draft ? undefined : cb.drafts.edit(cb.sourcePath, comment);

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

		const editButton = editDraft ? header.createEl("button", { cls: "irc-edit", attr: { "aria-label": "Edit comment", title: "Edit comment", type: "button" } }) : undefined;
		if (editButton && editDraft) {
			setIcon(editButton, "pencil");
			owner.registerDomEvent(editButton, "click", () => {
				editDraft.beginEdit(comment);
				body.querySelector("textarea")?.focus({ preventScroll: true });
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
		if (draft) initialBox = buildComposer(body, cb.app, owner, draft, true, (text) => cb.onPost(comment, text), cb.onEscape);
		else if (editDraft) {
			const rendered = body.createDiv({ cls: "irc-rendered-body" });
			if (text) cb.renderBody(rendered, text, owner);
			else if (!comment.quote) rendered.setText("(Empty comment)");
			const editSlot = body.createDiv({ cls: "irc-edit-slot" });
			let editOwner: Component | undefined;
			const paintEdit = () => {
				rendered.hidden = editDraft.editing;
				editSlot.hidden = !editDraft.editing;
				if (editButton) editButton.disabled = editDraft.submitting;
				if (editDraft.editing && !editOwner) {
					editOwner = owner.addChild(new Component());
					buildComposer(editSlot, cb.app, editOwner, editDraft, true, (text) => cb.onEdit(editDraft.target ?? comment, text), cb.onEscape, {
						edit: true,
						onSaved: () => editDraft.endEdit(),
						onCancel: () => { editDraft.endEdit(); if (editButton?.isConnected) editButton.focus({ preventScroll: true }); },
					});
				} else if (!editDraft.editing && editOwner) {
					owner.removeChild(editOwner);
					editOwner = undefined;
					editSlot.empty();
				}
			};
			owner.register(editDraft.subscribe(paintEdit));
			paintEdit();
		}
	});

	const composer = initialBox ?? buildComposer(card, cb.app, owner, cb.drafts.reply(cb.sourcePath, thread[0]), false, (text) => cb.onReply(thread, text), cb.onEscape);
	cb.bindStatus?.(card, thread, owner, composer);
	return card;
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
