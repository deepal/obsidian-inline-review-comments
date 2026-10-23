import { Component, MarkdownView, Notice, TFile, type Events, type Plugin } from "obsidian";
import { BRIDGE_CHANGED, BRIDGE_DISCOVER, LEGACY_BRIDGE_CHANGED, LEGACY_BRIDGE_DISCOVER, hasMention, isAgentBridge, type AgentBridge, type CommentSource, type MentionRequest } from "./agent-bridge.ts";

export interface MentionComment {
	id: string | null;
	from: number;
	to: number;
	body: string;
	author: string | null;
	quote?: string | null;
	agent?: boolean;
}
export interface CommentFormat {
	parse(text: string): MentionComment[];
	thread(text: string, target: MentionComment): MentionComment[];
	identify(text: string, target: MentionComment, id: string): string;
	reply(text: string, request: MentionRequest, author: string, body: string): string;
	replied(text: string, requestId: string): boolean;
}

/** Optional UI-side integration. No process, filesystem, or settings dependency. */
export class MentionClient extends Component {
	private bridge?: AgentBridge;
	private detach?: () => void;
	private unsubscribe?: () => void;
	private listeners = new Set<() => void>();
	private sending = new Set<string>();
	private sequence: Promise<void> = Promise.resolve();
	private disposed = false;
	private lastEnabled = true;
	epoch = 0;

	constructor(private readonly plugin: Plugin, private readonly source: CommentSource,
		private readonly format: CommentFormat, private readonly enabled: () => boolean) { super(); this.lastEnabled = enabled(); }
	get active(): boolean { return !this.disposed && this.enabled() && !!this.bridge?.tag; }
	get tag(): string { return this.active ? this.bridge!.tag : ""; }
	get generation(): string { return `${this.epoch}:${this.tag}`; }

	onload(): void {
		for (const event of [BRIDGE_CHANGED, LEGACY_BRIDGE_CHANGED]) this.registerEvent((this.plugin.app.workspace as Events).on(event, () => this.connect()));
		this.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			if (file instanceof TFile && this.active) void this.check(file.path);
		}));
		this.registerEvent(this.plugin.app.vault.on("delete", (file) => { if (this.active) void this.check(file.path); }));
		this.connect();
	}
	onunload(): void {
		this.disposed = true;
		this.detach?.(); this.unsubscribe?.(); this.bridge = undefined;
		this.notify(); this.listeners.clear();
	}
	settingsChanged(): void {
		this.epoch++;
		if (this.enabled() !== this.lastEnabled) {
			this.lastEnabled = this.enabled();
			this.connect();
		} else this.notify();
	}
	private connect(): void {
		let found: AgentBridge | undefined;
		for (const [event, version] of [[BRIDGE_DISCOVER, 2], [LEGACY_BRIDGE_DISCOVER, 1]] as const) {
			if (found) break;
			(this.plugin.app.workspace as Events).trigger(event, (candidate: unknown) => {
				if (this.enabled() && isAgentBridge(candidate, version) && candidate.tag) found = candidate;
			});
		}
		if (found && found === this.bridge) { this.epoch++; this.notify(); return; }
		this.detach?.(); this.unsubscribe?.();
		this.bridge = found; this.epoch++;
		this.detach = found?.attach(this.source, {
			prepare: () => this.prepare(),
			validate: (request) => this.validate(request),
			publish: (request, author, body) => this.publish(request, author, body),
		});
		this.unsubscribe = found?.subscribe(() => this.notify());
		this.notify();
	}
	private notify(): void { for (const listener of this.listeners) listener(); }
	changed(path: string): void {
		if (this.active) void this.check(path).catch((error: unknown) => console.error("[agent-mentions] Could not validate active comments", error));
	}
	private async check(path: string): Promise<void> {
		for (const job of this.bridge?.jobs(this.source, path) ?? []) {
			// Once a v2 answer exists, publication reports conflicts and retains it for retry.
			if (this.bridge?.version === 2 && job.state === "applying") continue;
			if (["queued", "running", "applying"].includes(job.state) && !(await this.validate(job.request))) this.bridge?.cancel(job.request.id);
		}
	}
	private sourceViews(path?: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file && (!path || leaf.view.file.path === path) && leaf.view.getMode() === "source") views.push(leaf.view);
		});
		return views;
	}
	private savedText(view: MarkdownView): string | undefined {
		// TextFileView.data follows in-memory edits before the debounced save.
		// Its lastSavedData tracks the disk baseline; saving marks a pending write.
		const saved = (view as MarkdownView & { lastSavedData?: unknown }).lastSavedData;
		return typeof saved === "string" ? saved : undefined;
	}
	private async waitForSaves(path: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (!this.sourceViews(path).some((view) => (view as MarkdownView & { saving?: boolean }).saving)) return;
			await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
		}
		throw new Error(`Obsidian is still saving ${path}. Wait for it to finish, then submit the mention again.`);
	}
	private async flush(path: string): Promise<void> {
		if (this.bridge?.version !== 2) { await Promise.all(this.sourceViews(path).map((view) => view.save())); return; }
		for (let attempt = 0; attempt < 20; attempt++) {
			await this.waitForSaves(path);
			const views = this.sourceViews(path);
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new Error(`The note is unavailable: ${path}`);
			const text = await this.plugin.app.vault.read(file);
			const values = views.map((view) => view.editor.getValue());
			// A debounced save may have started while vault.read was pending.
			if (views.some((view) => (view as MarkdownView & { saving?: boolean }).saving)) continue;
			if (values.every((value) => value === text)) return;
			if (new Set(values).size > 1 || views.some((view, i) => values[i] !== text && this.savedText(view) !== text)) {
				throw new Error(`Unsaved editor content conflicts with changes on disk in ${path}. Resolve it before submitting the mention again; the agent's edits have not been overwritten.`);
			}
			// Save only edits based on current disk content. Recheck after each save,
			// including any autosave already started by Obsidian, before execution.
			await views.find((view) => view.editor.getValue() !== text)!.save();
		}
		throw new Error(`The editor keeps changing in ${path}. Finish editing, then submit the mention again.`);
	}
	private async prepare(): Promise<void> {
		const paths = new Set(this.sourceViews().map((view) => view.file!.path));
		for (const path of paths) await this.flush(path);
	}
	private async settleEditors(file: TFile): Promise<void> {
		// External CLI writes can precede Obsidian's filesystem watcher. Let clean
		// buffers catch up, but never reload or save over an actual user draft.
		for (let attempt = 0; attempt < 15; attempt++) {
			const text = await this.plugin.app.vault.read(file);
			const views = this.sourceViews(file.path);
			if (views.every((view) => view.editor.getValue() === text) ||
				views.some((view) => view.editor.getValue() !== this.savedText(view))) return;
			await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
		}
	}
	private assertCurrentEditors(path: string, text: string): void {
		if (this.sourceViews(path).some((view) => view.editor.getValue() !== text)) {
			throw new Error("The agent response was retained because an editor differs from the current note. Resolve the unsaved content or reload that editor, then Retry to post the saved response without rerunning the agent.");
		}
	}
	private async refreshReading(path: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const text = await this.plugin.app.vault.read(file);
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.getMode() === "preview") {
				// A saved note can reach a preview before its identity metadata does.
				// Set the current preview's source explicitly before forcing a render.
				leaf.view.setViewData(text, false);
				leaf.view.previewMode.rerender(true);
			}
		});
	}
	private async validate(request: MentionRequest): Promise<boolean> {
		if (!this.active) return false;
		// Check unsaved editor buffers first, rather than accepting stale disk content.
		let invalid = false;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === request.notePath && leaf.view.getMode() === "source") {
				if (!this.matches(leaf.view.editor.getValue(), request)) invalid = true;
			}
		});
		if (invalid) return false;
		const file = this.plugin.app.vault.getAbstractFileByPath(request.notePath);
		return file instanceof TFile && this.matches(await this.plugin.app.vault.read(file), request);
	}
	private matches(text: string, request: MentionRequest): boolean {
		const found = this.format.parse(text).filter((c) => c.id === request.commentId);
		return found.length === 1 && !found[0].agent && found[0].body === request.message && (found[0].quote ?? null) === request.quote;
	}

	/** Form writes provide before/after text; only explicitly changed messages qualify. */
	committed(path: string, before: string, after: string): void {
		if (!this.active) return;
		this.changed(path);
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) start++;
		let tail = 0;
		while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
		const end = after.length - tail;
		const previous = this.format.parse(before);
		const current = this.format.parse(after);
		for (const comment of current) {
			if (comment.to < start || comment.from > end || comment.agent || !hasMention(comment.body, this.tag)) continue;
			if (!comment.id) {
				const same = (c: MentionComment) => c.body === comment.body && c.author === comment.author && c.quote === comment.quote;
				if (previous.filter(same).length >= current.filter(same).length) continue;
			}
			const old = comment.id ? previous.find((c) => c.id === comment.id) : previous.find((c) => c.from === comment.from && c.body === comment.body);
			if (!old || old.body !== comment.body) this.send(path, comment);
		}
	}
	send(path: string, target: MentionComment): void {
		if (!this.active || target.agent || !hasMention(target.body, this.tag)) return;
		const key = `${path}:${target.id ?? target.from}`;
		if (this.sending.has(key)) return;
		this.sending.add(key);
		const generation = this.generation;
		this.sequence = this.sequence.catch(() => undefined).then(async () => {
			if (!this.active || generation !== this.generation) return;
			await this.flush(path);
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			const id = target.id ?? (this.source === "comment-block" ? String(Math.max(Date.now(), ...this.format.parse(await this.plugin.app.vault.read(file)).map((c) => Number(c.id) || 0)) + 1) : crypto.randomUUID());
			let request: MentionRequest | undefined;
			await this.plugin.app.vault.process(file, (text) => {
				const candidates = this.format.parse(text).filter((c) => target.id ? c.id === target.id : !c.id && c.body === target.body && c.author === target.author && c.quote === target.quote);
				const exact = candidates.filter((c) => c.from === target.from);
				const matches = target.id ? candidates : exact.length ? exact : candidates.length === 1 ? candidates : [];
				if (matches.length !== 1 || matches[0].body !== target.body || matches[0].agent) return text;
				const comment = matches[0];
				if (this.bridge!.jobs(this.source, path).some((j) => j.request.commentId === id)) return text;
				request = { id: crypto.randomUUID(), source: this.source, notePath: path, commentId: id, message: comment.body,
					quote: comment.quote ?? null,
					excerpt: this.format.thread(text, comment).find((c) => c.quote)?.quote ?? null,
					thread: this.format.thread(text, comment).map((c) => ({ author: c.author, body: c.body })) };
				return target.id ? text : this.format.identify(text, comment, id);
			});
			if (request && this.active && generation === this.generation) {
				// Allow Obsidian to deliver the metadata write to its editor buffers.
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				await this.refreshReading(path);
				if (this.active && generation === this.generation) await this.bridge!.submit(request);
			}
		}).catch((error: unknown) => {
			console.error("[agent-mentions] Could not submit comment", error);
			if (this.active) new Notice(`Agent request was not started: ${error instanceof Error ? error.message : String(error)}`, 10000);
		})
			.finally(() => this.sending.delete(key));
	}
	private async publish(request: MentionRequest, author: string, body: string): Promise<void> {
		const direct = this.bridge?.version === 2;
		if (!direct) {
			if (!(await this.validate(request))) throw new Error("The initiating comment changed or was removed.");
			await this.flush(request.notePath);
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(request.notePath);
		if (!(file instanceof TFile)) throw new Error("The note no longer exists. The response was retained.");
		if (direct) await this.settleEditors(file);
		await this.plugin.app.vault.process(file, (text) => {
			if (this.format.replied(text, request.id)) return text;
			if (direct) this.assertCurrentEditors(request.notePath, text);
			if (!this.matches(text, request)) throw new Error("The initiating comment changed or was removed. The response was retained.");
			return this.format.reply(text, request, author, body);
		});
		await this.refreshReading(request.notePath);
	}

	/** Refresh rendered mention styling on bridge/tag changes without touching composers. */
	bindBody(owner: Component, render: (tag: string) => void): void {
		let tag: string | undefined;
		const paint = () => {
			const next = this.tag;
			if (tag === next) return;
			tag = next;
			render(next);
		};
		this.listeners.add(paint);
		owner.register(() => this.listeners.delete(paint));
		paint();
	}

	/** Lock only this thread's reply controls, preserving its draft and original state. */
	bindComposer(composer: HTMLElement, path: string, commentIds: Array<string | null>, owner: Component): void {
		const controls = Array.from(composer.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>("textarea, button:not(.cb-form__cancel)"));
		const original = controls.map((control) => control.disabled);
		let locked = false;
		const unlock = () => {
			if (!locked) return;
			controls.forEach((control, i) => { control.disabled = original[i]; });
			composer.removeClass("aio-mention-composer-busy");
			composer.removeAttribute("aria-busy");
			locked = false;
		};
		const paint = () => {
			const busy = this.active && this.bridge!.jobs(this.source, path).some((job) =>
				commentIds.includes(job.request.commentId) && ["queued", "running", "applying"].includes(job.state));
			if (!busy) { unlock(); return; }
			if (locked) return;
			controls.forEach((control) => { control.disabled = true; });
			composer.addClass("aio-mention-composer-busy");
			composer.setAttribute("aria-busy", "true");
			locked = true;
		};
		this.listeners.add(paint);
		owner.register(() => { this.listeners.delete(paint); unlock(); });
		paint();
	}

	/** Patch only this small status element; never replace the thread or its composer. */
	bind(container: HTMLElement, path: string, commentIds: Array<string | null>, owner: Component, layout: () => void = () => undefined, before?: HTMLElement): void {
		let status: HTMLElement | undefined;
		let signature = "";
		const steps = new Map<string, HTMLElement>();
		const paint = () => {
			const jobs = this.active ? this.bridge!.jobs(this.source, path).filter((j) => commentIds.includes(j.request.commentId) && j.state !== "completed") : [];
			const next = JSON.stringify(jobs.map((j) => [j.request.id, j.tag, j.state, j.error, j.state === "cancelled" ? j.detail : undefined]));
			if (next === signature) {
				let changed = false;
				for (const job of jobs) {
					const step = steps.get(job.request.id);
					const text = job.detail || "Starting…";
					if (step && step.textContent !== text) { step.setText(text); changed = true; }
				}
				if (changed) layout();
				return;
			}
			signature = next;
			if (!jobs.length) { status?.remove(); status = undefined; steps.clear(); layout(); return; }
			if (!status) {
				status = container.createDiv({ cls: "aio-mention-status", attr: { role: "status", "aria-live": "polite" } });
				if (before) container.insertBefore(status, before);
			}
			status.empty();
			steps.clear();
			for (const job of jobs) {
				const row = status.createDiv({ cls: "aio-mention-job" });
				const busy = job.state === "running" || job.state === "applying";
				if (busy) {
					const typing = row.createSpan({ cls: "aio-mention-typing", attr: { role: "img", "aria-label": `${job.tag} is typing` } });
					for (let i = 0; i < 3; i++) typing.createSpan({ cls: "aio-mention-dot", attr: { "aria-hidden": "true" } });
				} else {
					row.createSpan({ text: job.state === "queued" ? `${job.tag} is queued…` : `${job.tag}: ${job.error ?? job.detail ?? job.state}` });
				}
				if (job.state === "failed") {
					const retry = row.createEl("button", { text: "Retry", attr: { type: "button" } });
					retry.addEventListener("click", () => { void this.bridge?.retry(job.request.id).catch((error: unknown) => console.error("[agent-mentions] Retry failed", error)); });
				} else if (busy || job.state === "queued") {
					const cancel = row.createEl("button", { cls: "aio-mention-cancel", attr: { type: "button", title: "Stop response", "aria-label": `Stop ${job.tag}'s response` } });
					cancel.createSpan({ cls: "aio-mention-stop-icon", attr: { "aria-hidden": "true" } });
					cancel.addEventListener("click", () => this.bridge?.cancel(job.request.id));
				}
				if (busy) steps.set(job.request.id, row.createDiv({ cls: "aio-mention-step", text: job.detail || "Starting…" }));
			}
			layout();
		};
		this.listeners.add(paint);
		owner.register(() => { this.listeners.delete(paint); status?.remove(); });
		paint();
	}
}
