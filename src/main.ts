import { MentionClient } from "./mention-client.ts";
import { inlineFormat } from "./mention-format.ts";
import { mentionExtension } from "./mention-extension.ts";
import { Editor, Plugin } from "obsidian";
import { createEditorExtension } from "./editor-extension";
import { createHideMarkersExtension } from "./hide-markers";
import { createAutoCommentExtension } from "./auto-comment";
import { ReadingViewManager } from "./reading-view";
import { RenderedMarkerManager } from "./rendered-markers";
import { DraftStore } from "./drafts";
import { ThreadCountStatus } from "./thread-count-status";
import { AuthorStore } from "./author";
import { promptForAuthor, suggestAuthorName } from "./author-prompt";
import type { EditorView } from "@codemirror/view";
import {
	DEFAULT_SETTINGS,
	legacyUsername,
	normalizeSettings,
	InlineReviewSettings,
	InlineReviewSettingTab,
} from "./settings";

/** Minimal interface a margin renderer exposes so settings changes can force a redraw. */
export interface MarginRenderer {
	readonly view: EditorView;
	redraw(): void;
	/** True when this renderer owns and handled the command, including a safe rejection. */
	insertComment(editor: Editor, author: string): boolean;
	requestDraftFocus(id: string, origin: EditorView): void;
	destroy(): void;
}

export default class InlineReviewCommentPlugin extends Plugin {
	settings: InlineReviewSettings = DEFAULT_SETTINGS;

	/** Live editing-mode renderers (one per open CodeMirror editor). */
	readonly editorRenderers = new Set<MarginRenderer>();

	/** Bumped on every settings change so editor extensions can rebuild. */
	settingsVersion = 0;

	mentions!: MentionClient;
	readonly drafts = new DraftStore();
	/** Comment author for this vault on this device; never stored in data.json. */
	author!: AuthorStore;

	/** `username` from a data.json written by older versions, used only as a prefill. */
	private legacyUsername = "";
	private pendingAuthor: Promise<string | null> | null = null;

	private readingManager!: ReadingViewManager;
	private markerManager!: RenderedMarkerManager;

	async onload(): Promise<void> {
		this.author = new AuthorStore(this.app, `${this.manifest.id}:author`);
		await this.loadSettings();
		this.addChild(new ThreadCountStatus(this)).load();

		this.mentions = this.addChild(new MentionClient(this, "inline-review-comment", inlineFormat, () => this.settings.enabled));
		this.mentions.load();
		this.registerEditorExtension(mentionExtension(this.mentions, inlineFormat));
		this.readingManager = new ReadingViewManager(this);
		this.markerManager = new RenderedMarkerManager(this);

		this.registerEditorExtension([
			createEditorExtension(this),
			this.markerManager.editorExtension(),
			createHideMarkersExtension(this),
			createAutoCommentExtension(this),
		]);
		this.registerMarkdownPostProcessor(this.readingManager.handleBlock);
		this.registerMarkdownPostProcessor(this.markerManager.handleBlock);

		this.addSettingTab(new InlineReviewSettingTab(this.app, this));
		this.updateBodyClass();

		this.addCommand({
			id: "insert-comment",
			name: "Insert comment at cursor",
			editorCallback: (editor) => void this.insertComment(editor),
		});

		// Defer until layout is ready so core commands are registered.
		this.app.workspace.onLayoutReady(() => this.applyToggleOverride());
	}

	private toggleCmd: { editorCallback?: (editor: Editor) => void } | null = null;
	private originalToggleCallback: ((editor: Editor) => void) | undefined;

	/**
	 * Replaces the core "Toggle comment" (editor:toggle-comments) action so its
	 * existing shortcut (Cmd/Ctrl+/) inserts an authored comment. Reversible via
	 * `restoreToggleOverride()` and the `overrideToggleComment` setting.
	 */
	applyToggleOverride(): void {
		if (!this.settings.overrideToggleComment) {
			this.restoreToggleOverride();
			return;
		}
		const cmds = (this.app as unknown as { commands?: { commands?: Record<string, { editorCallback?: (editor: Editor) => void }> } })
			.commands?.commands;
		const cmd = cmds?.["editor:toggle-comments"];
		if (!cmd || this.toggleCmd) return; // missing, or already patched

		this.toggleCmd = cmd;
		this.originalToggleCallback = cmd.editorCallback;
		cmd.editorCallback = (editor: Editor) => void this.insertComment(editor);
	}

	/** Restores the original core "Toggle comment" behaviour. */
	restoreToggleOverride(): void {
		if (this.toggleCmd) {
			this.toggleCmd.editorCallback = this.originalToggleCallback;
			this.toggleCmd = null;
			this.originalToggleCallback = undefined;
		}
	}

	/**
	 * Inserts an authored comment at the cursor. With a selection, the selected
	 * prose is left untouched and a copy is embedded as a quoted excerpt:
	 * `%% ::name:: {quote}<selection>{/quote}  %%` is inserted at the end of the
	 * selection, then focus the new card's composer. When cards cannot be shown,
	 * keep the caret inside the empty body for editing directly in the note.
	 * The author prefix is omitted for anonymous comments.
	 */
	private async insertComment(editor: Editor): Promise<void> {
		const name = await this.resolveAuthor();
		if (name === null) return;
		if (this.settings.enabled) {
			for (const renderer of this.editorRenderers) if (renderer.insertComment(editor, name)) return;
		}
		const left = name ? `%% ::${name}:: ` : `%% `;
		const right = ` %%`;

		const selection = editor.getSelection();
		const lead = selection ? `${left}{quote}${selection}{/quote} ` : left;

		// Insert at the end of the selection (or the bare cursor), leaving the
		// selected prose in place. Offset math keeps the caret correct even when
		// the quoted excerpt spans multiple lines.
		const at = editor.getCursor("to");
		const caret = editor.posToOffset(at) + lead.length;
		editor.replaceRange(lead + right, at);
		editor.setCursor(editor.offsetToPos(caret));
		editor.focus();
	}

	onunload(): void {
		// Obsidian can cache table-cell editors across extension reloads. Stop
		// their input handlers and release their renderers explicitly as well.
		this.settings = { ...this.settings, enabled: false };
		for (const renderer of [...this.editorRenderers]) renderer.destroy();
		this.readingManager?.destroy();
		this.markerManager?.destroy();
		this.restoreToggleOverride();
		this.drafts.clear();
		document.body.classList.remove("irc-active");
	}

	/** Forces every live renderer to redraw (e.g. after a settings change). */
	refreshAll(): void {
		this.mentions?.settingsChanged();
		this.settingsVersion++;
		this.updateBodyClass();
		for (const renderer of this.editorRenderers) renderer.redraw();
		this.readingManager?.refresh();
		this.markerManager?.refresh();
		// Nudge each open editor so the marker-hiding extension rebuilds against
		// the new settings (settings changes don't otherwise dispatch a tx).
		this.app.workspace.iterateAllLeaves((leaf) => {
			const cm = (leaf.view as { editor?: { cm?: { dispatch: (s: object) => void } } })
				.editor?.cm;
			cm?.dispatch({});
		});
	}

	/** Reflects the enabled setting on <body> so editor CSS can react to it. */
	private updateBodyClass(): void {
		document.body.classList.toggle("irc-active", this.settings.enabled);
	}

	/**
	 * The author for a new comment or reply. Asks once per vault and device;
	 * resolves to null when the user dismisses the question, which cancels the
	 * comment. Concurrent callers share one dialog.
	 */
	resolveAuthor(): Promise<string | null> {
		const known = this.author.get();
		if (known !== null) return Promise.resolve(known);
		this.pendingAuthor ??= this.askForAuthor().finally(() => { this.pendingAuthor = null; });
		return this.pendingAuthor;
	}

	private async askForAuthor(): Promise<string | null> {
		const suggestion = await suggestAuthorName(this.app) ?? this.legacyUsername;
		const name = await promptForAuthor(this.app, suggestion);
		if (name !== null) this.author.set(name);
		return name;
	}

	async loadSettings(): Promise<void> {
		const raw: unknown = await this.loadData();
		this.settings = normalizeSettings(raw);
		this.legacyUsername = legacyUsername(raw);
	}

	/** data.json changed through git or Sync: adopt it instead of overwriting it on the next save. */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.applyToggleOverride();
		this.refreshAll();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
