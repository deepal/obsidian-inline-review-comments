import { Editor, MarkdownView, editorInfoField } from "obsidian";
import { renderCommentBody } from "./render";
import { Extension, MapMode } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { groupComments, parseComments, ParsedComment } from "./parser";
import {
	findRemovalRange,
	findReplyEnd,
	findThreadRange,
	commentMarkdown,
	initialCommentChange,
	editCommentChange,
} from "./comment-edit";
import { insertDraft, openDraft } from "./draft-creation";
import { CardLayer, AnchorItem } from "./card-layer";
import { activeEditorView, owningNoteView } from "./editor-host";
import { tableRowForLine, TableResizeObserver } from "./table-anchor";
import { encodeComment } from "./comment-context";
import { applyMargin, computeMarginLayout, measureMargin } from "./margin-geometry";
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
			layer: CardLayer | null = null;
			view: EditorView;
			scheduled = false;
			destroyed = false;
			pendingFocus: { id: string; origin: EditorView; path: string } | null = null;
			cancelFocusListeners: (() => void) | null = null;
			tables: TableResizeObserver;
			writes = new Set<{ from: number; to: number; expected: string; previous: string }>();
			path(): string { return plugin.drafts.path(this.view.state.field(editorInfoField, false)?.file?.path, this.view); }

			constructor(view: EditorView) {
				this.view = view;
				this.tables = new TableResizeObserver(() => this.schedule(view));
				plugin.editorRenderers.add(this);
				if (owningNoteView(view) === view) this.attachLayer();
				this.schedule(view);
			}

			attachLayer(): void {
					// Obsidian resets cm-content classes when switching editing modes.
					// Restore ownership even when the existing margin layer is reused.
					this.view.contentDOM.classList.add("irc-note-content");
				if (this.layer) return;
				this.layer = new CardLayer(this.view.scrollDOM, plugin.settings.cardWidth);
				plugin.drafts.observe(this.path(), this.view.state.doc.toString());
			}

			cancelDraftFocus(): void {
				this.pendingFocus = null;
				this.cancelFocusListeners?.();
				this.cancelFocusListeners = null;
			}

			requestDraftFocus(id: string, origin: EditorView): void {
				if (this.destroyed || owningNoteView(this.view) !== this.view || owningNoteView(origin) !== this.view) return;
				this.cancelDraftFocus();
				const doc = this.view.dom.ownerDocument;
				this.pendingFocus = { id, origin, path: this.path() };
				const cancel = () => this.cancelDraftFocus();
				const focus = (event: FocusEvent) => {
					const target = event.target as Node | null;
					// Obsidian can retire the cell editor while syncing its text.
					if (target && !origin.dom.contains(target) && target !== this.view.contentDOM) cancel();
				};
				doc.addEventListener("pointerdown", cancel, true);
				doc.addEventListener("keydown", cancel, true);
				doc.addEventListener("focusin", focus, true);
				this.cancelFocusListeners = () => {
					doc.removeEventListener("pointerdown", cancel, true);
					doc.removeEventListener("keydown", cancel, true);
					doc.removeEventListener("focusin", focus, true);
				};
				this.schedule(this.view);
			}

			/** Forces a redraw (used by the plugin after settings changes). */
			redraw(): void {
				this.schedule(this.view);
			}

			update(u: ViewUpdate): void {
				if (this.destroyed) return;
				if (u.docChanged && owningNoteView(this.view) === this.view) {
					plugin.drafts.observe(this.path(), u.state.doc.toString(), (offset) => u.changes.mapPos(offset, 1, MapMode.TrackAfter) ?? -1, u.startState.doc.toString());
					for (const write of this.writes) {
						write.from = u.changes.mapPos(write.from, 1);
						write.to = u.changes.mapPos(write.to, -1);
					}
				}
				for (const tr of u.transactions) for (const effect of tr.effects) if (effect.is(openDraft)) {
					const owner = owningNoteView(this.view);
					const renderer = [...plugin.editorRenderers].find((r) => r.view === owner);
					const path = this.path();
					// Never dispatch or focus another CodeMirror view during an update.
					queueMicrotask(() => {
						if (this.path() === path) renderer?.requestDraftFocus(effect.value, this.view);
					});
				}
				if (this.pendingFocus && this.pendingFocus.path !== this.path()) this.cancelDraftFocus();
				if (u.docChanged || u.viewportChanged || u.geometryChanged) {
					this.schedule(u.view);
				}
			}

			insertComment(editor: Editor): boolean {
				if (owningNoteView(this.view) !== this.view || this.view.state.field(editorInfoField, false)?.editor !== editor) return false;
				const target = activeEditorView(this.view);
				const selection = target.state.selection.main;
				const quote = target.state.sliceDoc(selection.from, selection.to) || undefined;
				target.focus();
				insertDraft(target, plugin.drafts, plugin.settings.username, selection.to, selection.to, quote);
				// This editor handled the command even when the parser rejected an
				// unsafe insertion. Do not fall through to raw Markdown insertion.
				return true;
			}

			/** Coalesces multiple updates in a frame into one draw. */
			schedule(view: EditorView): void {
				if (this.scheduled || this.destroyed) return;
				this.scheduled = true;
				view.requestMeasure({
					read: () => {
						this.scheduled = false;
						if (!this.destroyed) this.draw(view);
					},
				});
			}

			draw(view: EditorView): void {
				if (owningNoteView(view) !== view) {
					this.layer?.destroy();
					this.layer = null;
					this.cancelDraftFocus();
					this.tables.update([]);
					view.contentDOM.classList.remove("irc-note-content");
					view.contentDOM.classList.remove("irc-has-comments");
					view.scrollDOM.classList.remove("irc-has-comments");
					applyMargin(view.scrollDOM, null);
					return;
				}
				this.attachLayer();
				const layer = this.layer!;
				const scroller = view.scrollDOM;

				if (!plugin.settings.enabled) {
					this.cancelDraftFocus();
					layer.clear();
					this.tables.update([]);
					scroller.classList.remove("irc-has-comments");
					view.contentDOM.classList.remove("irc-has-comments");
					applyMargin(scroller, null);
					return;
				}

				const text = view.state.doc.toString();
				const comments = parseComments(text);
				plugin.drafts.observe(this.path(), text);
				// Measure before toggling the gutter classes, which change the column.
				// `.cm-sizer` is the element readable line length caps.
				const sizer = Array.from(scroller.children).find((el): el is HTMLElement => el.classList.contains("cm-sizer")) ?? null;
				const margin = computeMarginLayout(measureMargin(scroller, sizer, plugin.settings.cardWidth));
				// Reserve a right gutter (via CSS) only when the note has comments.
				scroller.classList.toggle("irc-has-comments", comments.length > 0);
				view.contentDOM.classList.toggle("irc-has-comments", comments.length > 0);
				applyMargin(scroller, comments.length > 0 ? margin : null);
				layer.setWidth(margin.cardWidth);
				layer.setLeft(margin.cardLeft);

				// Position cards in *content* coordinates (independent of scroll),
				// so the native scroll of the layer keeps them glued to the text.
				// Use the height map (documentTop + lineBlockAt) rather than
				// coordsAtPos: it resolves a position for the whole document, not
				// just the rendered viewport, so a tall card whose anchor has
				// scrolled off-screen above isn't dropped while you read it.
				const scrollerTop = scroller.getBoundingClientRect().top;
				const scrollOffset = scroller.scrollTop;
				const docTop = view.documentTop;
				const lines = text.split("\n");
				const tables = Array.from(view.contentDOM.querySelectorAll<HTMLTableElement>(".cm-table-widget table"))
					.filter((table) => table.closest(".cm-editor") === view.dom);
				this.tables.update(tables);
				const tableRanges = tables.flatMap((table) => {
					const widget = table.closest<HTMLElement>(".cm-table-widget");
					if (!widget) return [];
					try {
						const block = view.lineBlockAt(view.posAtDOM(widget, 0));
						return [{ table, from: view.state.doc.lineAt(block.from).number - 1, to: view.state.doc.lineAt(block.to).number - 1 }];
					} catch { return []; } // A widget may have been replaced during layout.
				});

				const items: AnchorItem[] = [];
				for (const thread of groupComments(comments, text)) {
					const comment = thread[0];
					const range = tableRanges.find((table) => comment.lineStart >= table.from && comment.lineStart <= table.to);
					const row = range && tableRowForLine(range.table, lines, range.from, range.to, comment.lineStart);
					const anchorTop = row ? row.getBoundingClientRect().top : docTop + view.lineBlockAt(comment.from).top;
					items.push({ thread, top: anchorTop - scrollerTop + scrollOffset });
				}

				const sourcePath = view.state.field(editorInfoField)?.file?.path ?? "";
				layer.render(items, {
					app: plugin.app,
					drafts: plugin.drafts,
					sourcePath: this.path(),
					onEscape: () => view.focus(),
					bindStatus: (card, thread, owner, replyBox) => {
						const ids = thread.map((c) => c.id ?? null);
						plugin.mentions.bind(card, sourcePath, ids, owner, () => this.schedule(view), replyBox);
						plugin.mentions.bindComposer(replyBox, sourcePath, ids, owner);
					},
					onDelete: (c) => this.deleteComment(view, c),
					onReply: (thread, text) => this.reply(view, thread, text),
					onPost: (comment, text) => this.post(view, comment, text),
					onEdit: async (comment, text) => {
						const change = editCommentChange(view.state.doc.toString(), comment, text);
						return change ? this.commit(view, change, false) : false;
					},
					onResolve: (thread) => this.resolveThread(view, thread),
					renderBody: (el, md, owner = plugin) => plugin.mentions.bindBody(owner, (tag) => {
						el.empty();
						renderCommentBody(plugin.app, owner, el, md, sourcePath, tag);
					}),
				});
				const request = this.pendingFocus;
				if (request && request.path !== this.path()) this.cancelDraftFocus();
				if (request && comments.some((comment) => comment.id === request.id)) queueMicrotask(() => {
					if (this.pendingFocus !== request) return;
					const doc = view.dom.ownerDocument;
					const focused = doc.activeElement;
					const allowed = focused === doc.body || focused === view.contentDOM || !!(focused && request.origin.dom.contains(focused));
					const input = layer.el.querySelector<HTMLTextAreaElement>(`[data-irc-comment-id="${request.id}"] textarea`);
					this.cancelDraftFocus();
					if (allowed && !this.destroyed && view.dom.isConnected && request.path === this.path()) input?.focus({ preventScroll: true });
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

			async post(view: EditorView, comment: ParsedComment, text: string): Promise<boolean> {
				const change = initialCommentChange(view.state.doc.toString(), comment, text);
				if (!change) return false;
				return this.commit(view, change);
			}

			async reply(view: EditorView, thread: ParsedComment[], text: string): Promise<boolean> {
				const before = view.state.doc.toString();
				const end = findReplyEnd(before, thread);
				if (end == null) return false;
				return this.commit(view, { from: end, to: end, insert: encodeComment(before, end, ` ${commentMarkdown(plugin.settings.username, text, null, crypto.randomUUID())}`) });
			}

			async commit(view: EditorView, change: { from: number; to: number; insert: string }, submitMentions = true): Promise<boolean> {
				const before = view.state.doc.toString();
				const info = view.state.field(editorInfoField, false);
				const path = info?.file?.path;
				const expected = before.slice(0, change.from) + change.insert + before.slice(change.to);
				view.dispatch({ changes: change });
				const write = { from: change.from, to: change.from + change.insert.length, expected: change.insert, previous: before.slice(change.from, change.to) };
				this.writes.add(write);
				try {
					// Obsidian can route a full-note dispatch through an active table
					// cell. Its outer document is updated asynchronously and reformatted.
					// Wait for the actual comments, rather than reading the stale buffer.
					const previous = parseComments(before);
					const targets = parseComments(expected).filter((c) => !previous.some((old) => old.id === c.id && old.from === c.from && old.body === c.body));
					const applied = () => {
						const current = view.state.doc.toString();
						if (current === before) return expected === before;
						const comments = parseComments(current);
						return targets.every((target) => comments.some((c) => (!target.id || c.id === target.id) && c.author === target.author && c.body === target.body && c.quote === target.quote));
					};
					for (let attempt = 0; !applied(); attempt++) {
						if (this.destroyed || view.state.field(editorInfoField, false)?.file?.path !== path) return false;
						if (attempt >= 200) throw new Error("The comment has not reached the note editor. Your draft was retained; finish editing the table cell and try again.");
						await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
					}
					let host = info instanceof MarkdownView ? info : undefined;
					if (!host) plugin.app?.workspace?.iterateAllLeaves((leaf) => {
						if (leaf.view instanceof MarkdownView && leaf.view.editor === info?.editor) host = leaf.view;
					});
					await host?.save();
					const after = view.state.doc.toString();
					if (path && before !== after) {
						if (submitMentions) plugin.mentions.committed(path, before, after);
						else plugin.mentions.changed(path);
					}
				} catch (error) {
					this.writes.delete(write);
					// Preserve unrelated edits while restoring a failed post's placeholder.
					if (view.state.field(editorInfoField, false)?.file?.path === path && write.from <= write.to && view.state.doc.sliceString(write.from, write.to) === write.expected) {
						view.dispatch({ changes: { from: write.from, to: write.to, insert: write.previous } });
					}
					throw error;
				} finally {
					this.writes.delete(write);
				}
				return true;
			}

			destroy(): void {
				if (this.destroyed) return;
				this.destroyed = true;
				this.cancelDraftFocus();
				this.tables.destroy();
				plugin.editorRenderers.delete(this);
				this.layer?.destroy();
				this.view.contentDOM.classList.remove("irc-note-content");
				this.view.contentDOM.classList.remove("irc-has-comments");
				this.view.scrollDOM.classList.remove("irc-has-comments");
				applyMargin(this.view.scrollDOM, null);
			}
		}
	);
}
