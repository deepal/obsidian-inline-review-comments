import { editorInfoField } from "obsidian";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { hasMention } from "./agent-bridge.ts";
import type { CommentFormat, MentionClient, MentionComment } from "./mention-client.ts";

/** Track only user input, never initial documents, sync writes or renderer activity. */
export function mentionExtension(client: MentionClient, format: CommentFormat) {
	return ViewPlugin.fromClass(class {
		private pending: MentionComment[] = [];
		private generation: string;
		private path: string;
		constructor(view: EditorView) {
			this.generation = client.generation;
			this.path = view.state.field(editorInfoField, false)?.file?.path ?? "";
		}
		update(update: ViewUpdate): void {
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
					const next = comments.find((c) => target.id ? c.id === target.id : c.from === from);
					return next && next.body === target.body ? [next] : [];
				});
				const userInput = update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
				if (userInput) {
					queueMicrotask(() => client.changed(path));
					const previous = format.parse(update.startState.doc.toString());
					for (const comment of comments) {
						if (comment.agent || !hasMention(comment.body, client.tag)) continue;
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
			const remaining: MentionComment[] = [];
			for (const target of this.pending) {
				const inside = update.state.selection.ranges.some((range) => range.empty ? range.from >= target.from && range.from < target.to : range.from < target.to && range.to > target.from);
				if (!inside || (update.focusChanged && !update.view.hasFocus)) {
					queueMicrotask(() => client.send(path, target));
				} else remaining.push(target);
			}
			this.pending = remaining;
		}
		destroy(): void { this.pending = []; }
	});
}
