import { editorInfoField } from "obsidian";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { hasMention } from "./agent-bridge.ts";
import type { CommentFormat, MentionClient, MentionComment } from "./mention-client.ts";
import { activeEditorView, owningNoteView } from "./editor-host.ts";
import { decodeTableComment } from "./comment-context.ts";

/** Track only user input, never initial documents, sync writes or renderer activity. */
export function mentionExtension(client: MentionClient, format: CommentFormat) {
	const trackers = new WeakMap<EditorView, { refresh(): void }>();
	return ViewPlugin.fromClass(class {
		private pending: MentionComment[] = [];
		private generation: string;
		private path: string;
		private timer: number | undefined;
		private view: EditorView;
		private focus = () => this.schedule();
		constructor(view: EditorView) {
			this.view = view;
			this.generation = client.generation;
			this.path = view.state.field(editorInfoField, false)?.file?.path ?? "";
			trackers.set(view, this);
			view.dom.addEventListener("focusin", this.focus);
			view.dom.addEventListener("focusout", this.focus);
		}
		private schedule(): void {
			if (!client.active || this.timer !== undefined) return;
			this.timer = window.setTimeout(() => {
				this.timer = undefined;
				const owner = owningNoteView(this.view);
				if (owner) trackers.get(owner)?.refresh();
			}, 0);
		}
		update(update: ViewUpdate): void {
			// Cell editors have local offsets. Their input is mirrored into the
			// owning note with its user-event annotation; only that note tracks it.
			// Selection/focus changes still need to wake the owning tracker.
			if (owningNoteView(update.view) !== update.view) {
				this.pending = [];
				this.schedule();
				return;
			}
			const path = update.state.field(editorInfoField, false)?.file?.path ?? "";
			if (!client.active || path !== this.path) {
				this.pending = []; this.generation = client.generation; this.path = path;
				return;
			}
			if (this.generation !== client.generation) { this.pending = []; this.generation = client.generation; }
			if (!path) return;
			const text = update.state.doc.toString();
			const comments = format.parse(text);
			if (update.docChanged) {
				this.pending = this.pending.flatMap((target) => {
					const from = update.changes.mapPos(target.from, -1);
					const candidates = comments.filter((c) => target.id ? c.id === target.id : c.body === target.body && c.author === target.author && c.quote === target.quote);
					const next = target.id ? candidates[0] : candidates.find((c) => c.from === from) ?? (candidates.length === 1 ? candidates[0] : undefined);
					return next && next.body === target.body ? [next] : [];
				});
				const userInput = update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
				if (userInput) {
					queueMicrotask(() => client.changed(path));
					const previous = format.parse(update.startState.doc.toString());
					for (const comment of comments) {
						if (comment.agent || !hasMention(comment.body, client.tag)) continue;
						// A table edit can replace/reformat the entire table. Unchanged
						// comments elsewhere in it are not new user activity.
						if (!comment.id) {
							const same = (c: MentionComment) => c.body === comment.body && c.author === comment.author && c.quote === comment.quote;
							if (previous.filter(same).length >= comments.filter(same).length) continue;
						}
						let touched = false;
						update.changes.iterChangedRanges((_a, _b, from, to) => { if (from <= comment.to && to >= comment.from) touched = true; });
						if (!touched) continue;
						const old = previous.find((c) => comment.id ? c.id === comment.id : update.changes.mapPos(c.from, -1) === comment.from);
						if (old?.body === comment.body) continue;
						this.pending = this.pending.filter((c) => c.from !== comment.from);
						this.pending.push(comment);
					}
				}
			}
			this.schedule();
		}
		refresh(): void {
			const view = this.view;
			if (!client.active || this.generation !== client.generation || view.state.field(editorInfoField, false)?.file?.path !== this.path) {
				this.pending = [];
				return;
			}
			const active = activeEditorView(view);
			const local = active !== view && active.hasFocus ? format.parse(active.state.doc.toString()).map((c) => ({ ...c, body: decodeTableComment(c.body), quote: c.quote ? decodeTableComment(c.quote) : c.quote })) : [];
			const selected = (target: MentionComment, editor: EditorView) => editor.state.selection.ranges.some((range) => range.empty ? range.from >= target.from && range.from < target.to : range.from < target.to && range.to > target.from);
			const remaining: MentionComment[] = [];
			for (const target of this.pending) {
				const inside = active === view ? view.hasFocus && selected(target, view) : local.some((c) => (target.id ? c.id === target.id : c.body === target.body && c.author === target.author && c.quote === target.quote) && selected(c, active));
				if (!inside) {
					client.send(this.path, target);
				} else remaining.push(target);
			}
			this.pending = remaining;
		}
		destroy(): void {
			this.pending = [];
			if (this.timer !== undefined) window.clearTimeout(this.timer);
			this.view.dom.removeEventListener("focusin", this.focus);
			this.view.dom.removeEventListener("focusout", this.focus);
			trackers.delete(this.view);
			const owner = owningNoteView(this.view);
			if (owner && owner !== this.view) queueMicrotask(() => trackers.get(owner)?.refresh());
		}
	});
}
