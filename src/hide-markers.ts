import { editorLivePreviewField } from "obsidian";
import { EditorState, Extension, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { parseComments } from "./parser";
import { initials, colorForName } from "./card";
import type InlineReviewCommentPlugin from "./main";

/**
 * The inline indicator for a comment thread: a small circular avatar showing
 * the first author's initials, or a filled dot when anonymous.
 */
class AvatarWidget extends WidgetType {
	constructor(private author: string | null) {
		super();
	}

	eq(other: AvatarWidget): boolean {
		return other.author === this.author;
	}

	toDOM(): HTMLElement {
		const span = createSpan();
		span.className = "irc-inline-avatar";
		if (this.author) {
			// Initials live in a child so their font-size doesn't shrink the
			// circle (em width is relative to the element's own font-size).
			const inner = createSpan();
			inner.className = "irc-inline-avatar-initials";
			inner.textContent = initials(this.author);
			span.appendChild(inner);
			span.style.backgroundColor = colorForName(this.author);
			span.setAttribute("aria-label", `Comment by ${this.author}`);
		} else {
			span.classList.add("irc-inline-avatar-anon");
			span.setAttribute("aria-label", "Comment");
		}
		return span;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * Editor extension that marks each comment with its author's avatar and, in
 * Live Preview, collapses the comment to just that avatar (revealing the raw
 * `%% %%` when the cursor is inside the comment, so editing still works). In
 * Source mode the text stays and the avatar is a prefix.
 *
 * Provided as a StateField (not a ViewPlugin) because collapsing a block /
 * multi-line comment produces a replace decoration that spans a line break,
 * which CodeMirror only permits from a state field.
 */
export function createHideMarkersExtension(plugin: InlineReviewCommentPlugin): Extension {
	const build = (state: EditorState): DecorationSet => {
		const builder = new RangeSetBuilder<Decoration>();
		if (!plugin.settings.enabled) return builder.finish();

		const livePreview = state.field(editorLivePreviewField, false) ?? false;
		const sel = state.selection;
		const text = state.doc.toString();

		for (const c of parseComments(text)) {
			const underCursor = sel.ranges.some((r) => r.from <= c.to && r.to >= c.from);
			const hide = livePreview && plugin.settings.hideCommentMarkers && !underCursor;

			if (hide) {
				// Collapse the comment to just its author avatar; moving the cursor
				// onto it reveals the raw `%% %%` again.
				builder.add(
					c.from,
					c.to,
					Decoration.replace({ widget: new AvatarWidget(c.author) })
				);
			} else {
				// Keep the text; prefix the comment with the author avatar.
				builder.add(
					c.from,
					c.from,
					Decoration.widget({ widget: new AvatarWidget(c.author), side: -1 })
				);
			}
		}

		return builder.finish();
	};

	return StateField.define<DecorationSet>({
		create: (state) => build(state),
		// Rebuild on every transaction — this covers edits, selection moves
		// (reveal-on-cursor), and the empty transaction refreshAll() dispatches
		// on a settings change. Scrolling needs no rebuild: decorations span the
		// whole document, not just the viewport.
		update: (_value, tr) => build(tr.state),
		provide: (f) => EditorView.decorations.from(f),
	});
}
