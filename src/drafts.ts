import { parseComments, type ParsedComment } from "./parser";

/** Session-only state, deliberately independent of a card's DOM lifetime. */
export class ComposerDraft {
	text = "";
	start = 0;
	end = 0;
	direction: "forward" | "backward" | "none" = "none";
	submitting = false;
	editing = false;
	target?: ParsedComment;
	private listeners = new Set<() => void>();

	constructor(readonly key: string) {}

	update(text: string, start: number, end: number, direction: typeof this.direction): void {
		this.text = text;
		this.start = start;
		this.end = end;
		this.direction = direction;
		this.notify();
	}

	busy(value: boolean): void { this.submitting = value; this.notify(); }
	clear(): void { this.update("", 0, 0, "none"); }
	beginEdit(target: ParsedComment): void {
		if (this.editing || this.submitting) return;
		this.editing = true;
		this.target = { ...target };
		this.update(target.body, target.body.length, target.body.length, "none");
	}
	endEdit(): void { this.editing = false; this.target = undefined; this.clear(); }
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private notify(): void { for (const listener of this.listeners) listener(); }
}

interface LegacyDraft {
	target: ParsedComment;
	draft: ComposerDraft;
	kind: "reply" | "edit";
}

/** Owns drafts until plugin unload, including while no note pane is open. */
export class DraftStore {
	private drafts = new Map<string, ComposerDraft>();
	private legacy = new Map<string, LegacyDraft[]>();
	private snapshots = new Map<string, string>();
	private untitled = new WeakMap<object, string>();

	path(filePath: string | undefined, editor: object): string {
		if (filePath) return filePath;
		let path = this.untitled.get(editor);
		if (!path) { path = `untitled:${crypto.randomUUID()}`; this.untitled.set(editor, path); }
		return path;
	}

	private key(path: string, kind: string, id: string): string { return JSON.stringify([path, kind, id]); }
	private get(key: string): ComposerDraft {
		let draft = this.drafts.get(key);
		if (!draft) { draft = new ComposerDraft(key); this.drafts.set(key, draft); }
		return draft;
	}

	start(path: string, id: string): ComposerDraft { return this.get(this.key(path, "comment", id)); }
	initial(path: string, comment: ParsedComment): ComposerDraft | undefined {
		return comment.id && !comment.body.trim() ? this.drafts.get(this.key(path, "comment", comment.id)) : undefined;
	}

	reply(path: string, root: ParsedComment): ComposerDraft {
		return this.message(path, root, "reply");
	}
	edit(path: string, comment: ParsedComment): ComposerDraft {
		return this.message(path, comment, "edit");
	}
	private message(path: string, root: ParsedComment, kind: "reply" | "edit"): ComposerDraft {
		if (root.id) return this.get(this.key(path, kind, root.id));
		let entries = this.legacy.get(path);
		if (!entries) { entries = []; this.legacy.set(path, entries); }
		let entry = entries.find((entry) => entry.kind === kind && entry.target.from === root.from && sameMessage(entry.target, root));
		if (!entry) {
			entry = { target: root, kind, draft: this.get(this.key(path, `legacy-${kind}`, crypto.randomUUID())) };
			entries.push(entry);
		}
		return entry.draft;
	}

	/** Map legacy message anchors when prose shifts; never attach a deleted draft elsewhere. */
	observe(path: string, text: string, mapPosition?: (offset: number) => number, previousText?: string): void {
		const before = this.snapshots.get(path);
		if (before === text) return;
		this.snapshots.set(path, text);
		if (before === undefined) return;
		let start = 0;
		while (start < before.length && start < text.length && before[start] === text[start]) start++;
		let tail = 0;
		while (tail < before.length - start && tail < text.length - start && before[before.length - tail - 1] === text[text.length - tail - 1]) tail++;
		// Another pane may already have advanced the snapshot, or this view may
		// have switched files. Its transaction then describes a different document.
		const map = mapPosition && (previousText === undefined || previousText === before) ? mapPosition : ((offset: number) => offset < start ? offset : offset >= before.length - tail ? offset + text.length - before.length : -1);
		const comments = parseComments(text);
		for (const entry of this.legacy.get(path) ?? []) {
			if (entry.target.from < 0) continue;
			const from = map(entry.target.from);
			const next = comments.find((c) => c.from === from && c.author === entry.target.author && c.quote === entry.target.quote && c.replyTo === entry.target.replyTo);
			if (entry.draft.target) entry.draft.target.from = next?.from ?? -1;
			if (!next) { entry.target = { ...entry.target, from: -1 }; continue; }
			entry.target = next;
			if (next.id) this.drafts.set(this.key(path, entry.kind, next.id), entry.draft);
		}
	}

	clear(): void { this.drafts.clear(); this.legacy.clear(); this.snapshots.clear(); }
}

function sameMessage(a: ParsedComment, b: ParsedComment): boolean {
	return a.author === b.author && a.body === b.body && a.quote === b.quote && a.replyTo === b.replyTo;
}
