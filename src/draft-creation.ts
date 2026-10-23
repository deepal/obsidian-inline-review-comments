import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { commentMarkdown } from "./comment-edit";
import { parseComments } from "./parser";
import type { DraftStore } from "./drafts";

export const openDraft = StateEffect.define<string>();

/** Shared by commands and typed %% expansion. Focus is deferred to the owning renderer. */
export function insertDraft(view: EditorView, drafts: DraftStore, username: string, from: number, to: number, quote?: string): boolean {
	const id = crypto.randomUUID();
	const insert = commentMarkdown(username, "", quote, id);
	const before = view.state.doc.toString();
	const after = before.slice(0, from) + insert + before.slice(to);
	// Code spans and existing comments cannot host a new review card.
	if (!parseComments(after).some((c) => c.from === from && c.id === id)) return false;
	const path = drafts.path(view.state.field(editorInfoField, false)?.file?.path, view);
	drafts.start(path, id);
	view.dispatch({
		changes: { from, to, insert },
		selection: { anchor: from + insert.length },
		effects: openDraft.of(id),
		userEvent: "input.complete",
		scrollIntoView: true,
	});
	return true;
}
