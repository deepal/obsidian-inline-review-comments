import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type InlineReviewCommentPlugin from "./main";
import { insertDraft } from "./draft-creation";

/**
 * When the user types the second `%` of a fresh `%%`, expand it into a full
 * comment placeholder, then focus its margin composer. Gated on the
 * `autoInsertOnType` setting; a single undo reverts to a plain `%%`.
 */
export function createAutoCommentExtension(plugin: InlineReviewCommentPlugin): Extension {
	return EditorView.inputHandler.of((view, from, to, text) => {
		if (!plugin.settings.enabled || !plugin.settings.autoInsertOnType) return false;
		if (text !== "%" || from !== to || from === 0) return false;

		const doc = view.state.doc;
		// The char immediately before must be a "%" (so we're completing "%%")…
		if (doc.sliceString(from - 1, from) !== "%") return false;
		// …but not a third "%", which would mean we're inside an existing "%%".
		if (from >= 2 && doc.sliceString(from - 2, from - 1) === "%") return false;

		return insertDraft(view, plugin.drafts, plugin.settings.username, from - 1, to);
	});
}
