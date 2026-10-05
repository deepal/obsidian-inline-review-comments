import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type InlineReviewCommentPlugin from "./main";

/**
 * When the user types the second `%` of a fresh `%%`, expand it into a full
 * comment template `%% ::name::  %%` with the caret in the body. Gated on the
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

		const name = plugin.settings.username.trim();
		const left = name ? `%% ::${name}:: ` : `%% `;
		const right = ` %%`;
		// Omit the leading "%" already in the document.
		const insert = left.slice(1) + right;

		view.dispatch({
			changes: { from, to, insert },
			selection: { anchor: from - 1 + left.length },
			userEvent: "input.complete",
		});
		return true;
	});
}
