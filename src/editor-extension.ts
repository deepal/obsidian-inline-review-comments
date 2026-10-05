import { editorInfoField } from "obsidian";
import { renderCommentBody } from "./render";
import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { groupComments, parseComments, ParsedComment } from "./parser";
import {
	findRemovalRange,
	findCommentEnd,
	findThreadRange,
	replyMarkdown,
} from "./comment-edit";
import { CardLayer, AnchorItem } from "./card-layer";
import type InlineReviewCommentPlugin from "./main";

/**
 * Builds the editor extension that renders review cards in the margin of the
 * Source and Live Preview editors. A single ViewPlugin instance exists per
 * editor; it redraws on every relevant update (including scroll/viewport
 * changes) and registers itself with the plugin so settings changes can force
 * a redraw.
 */
export function createEditorExtension(plugin: InlineReviewCommentPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			layer: CardLayer;
			view: EditorView;
			scheduled = false;

			constructor(view: EditorView) {
				this.view = view;
				// Append to the scroller so cards scroll natively with the text.
				this.layer = new CardLayer(view.scrollDOM, plugin.settings.cardWidth);
				plugin.editorRenderers.add(this);
				this.schedule(view);
			}

			/** Forces a redraw (used by the plugin after settings changes). */
			redraw(): void {
				this.schedule(this.view);
			}

			update(u: ViewUpdate): void {
				if (u.docChanged || u.viewportChanged || u.geometryChanged) {
					this.schedule(u.view);
				}
			}

			/** Coalesces multiple updates in a frame into one draw. */
			schedule(view: EditorView): void {
				if (this.scheduled) return;
				this.scheduled = true;
				view.requestMeasure({
					read: () => {
						this.scheduled = false;
						this.draw(view);
					},
				});
			}

			draw(view: EditorView): void {
				this.layer.setWidth(plugin.settings.cardWidth);
				const scroller = view.scrollDOM;

				if (!plugin.settings.enabled) {
					this.layer.clear();
					scroller.classList.remove("irc-has-comments");
					return;
				}

				const text = view.state.doc.toString();
				const comments = parseComments(text);
				// Reserve a right gutter (via CSS) only when the note has comments.
				scroller.classList.toggle("irc-has-comments", comments.length > 0);

				// Position cards in *content* coordinates (independent of scroll),
				// so the native scroll of the layer keeps them glued to the text.
				// Use the height map (documentTop + lineBlockAt) rather than
				// coordsAtPos: it resolves a position for the whole document, not
				// just the rendered viewport, so a tall card whose anchor has
				// scrolled off-screen above isn't dropped while you read it.
				const scrollerTop = scroller.getBoundingClientRect().top;
				const scrollOffset = scroller.scrollTop;
				const docTop = view.documentTop;

				const items: AnchorItem[] = [];
				for (const thread of groupComments(comments, text)) {
					const anchorTop = docTop + view.lineBlockAt(thread[0].from).top;
					items.push({ thread, top: anchorTop - scrollerTop + scrollOffset });
				}

				const sourcePath = view.state.field(editorInfoField)?.file?.path ?? "";
				this.layer.render(items, {
					onDelete: (c) => this.deleteComment(view, c),
					onReply: (thread, text) => this.reply(view, thread, text),
					onResolve: (thread) => this.resolveThread(view, thread),
					renderBody: (el, md) =>
						renderCommentBody(plugin.app, plugin, el, md, sourcePath),
				});
			}

			resolveThread(view: EditorView, thread: ParsedComment[]): void {
				const range = findThreadRange(view.state.doc.toString(), thread);
				if (!range) return;
				view.dispatch({ changes: { from: range.from, to: range.to, insert: "" } });
			}

			deleteComment(view: EditorView, comment: ParsedComment): void {
				const range = findRemovalRange(view.state.doc.toString(), comment);
				if (!range) return;
				view.dispatch({ changes: { from: range.from, to: range.to, insert: "" } });
			}

			reply(view: EditorView, thread: ParsedComment[], text: string): void {
				const end = findCommentEnd(view.state.doc.toString(), thread[thread.length - 1]);
				if (end == null) return;
				view.dispatch({
					changes: { from: end, insert: replyMarkdown(plugin.settings.username, text) },
				});
			}

			destroy(): void {
				plugin.editorRenderers.delete(this);
				this.layer.destroy();
			}
		}
	);
}
