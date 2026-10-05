import { Editor, Plugin } from "obsidian";
import { createEditorExtension } from "./editor-extension";
import { createHideMarkersExtension } from "./hide-markers";
import { createAutoCommentExtension } from "./auto-comment";
import { ReadingViewManager } from "./reading-view";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	InlineReviewSettings,
	InlineReviewSettingTab,
} from "./settings";

/** Minimal interface a margin renderer exposes so settings changes can force a redraw. */
export interface MarginRenderer {
	redraw(): void;
}

export default class InlineReviewCommentPlugin extends Plugin {
	settings: InlineReviewSettings = DEFAULT_SETTINGS;

	/** Live editing-mode renderers (one per open CodeMirror editor). */
	readonly editorRenderers = new Set<MarginRenderer>();

	/** Bumped on every settings change so editor extensions can rebuild. */
	settingsVersion = 0;

	private readingManager!: ReadingViewManager;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.readingManager = new ReadingViewManager(this);

		this.registerEditorExtension([
			createEditorExtension(this),
			createHideMarkersExtension(this),
			createAutoCommentExtension(this),
		]);
		this.registerMarkdownPostProcessor(this.readingManager.handleBlock);

		this.addSettingTab(new InlineReviewSettingTab(this.app, this));
		this.updateBodyClass();

		this.addCommand({
			id: "insert-comment",
			name: "Insert comment at cursor",
			editorCallback: (editor) => this.insertComment(editor),
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
		cmd.editorCallback = (editor: Editor) => this.insertComment(editor);
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
	 * selection, with the caret left in the (empty) body ready to type. With no
	 * selection, inserts an empty `%% ::name::  %%` and puts the caret in the
	 * body. The author prefix is omitted when no username is set.
	 */
	private insertComment(editor: Editor): void {
		const name = this.settings.username.trim();
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
		this.readingManager?.destroy();
		this.restoreToggleOverride();
		document.body.classList.remove("irc-active");
		// Editing-mode layers are torn down by each ViewPlugin's destroy().
	}

	/** Forces every live renderer to redraw (e.g. after a settings change). */
	refreshAll(): void {
		this.settingsVersion++;
		this.updateBodyClass();
		for (const renderer of this.editorRenderers) renderer.redraw();
		this.readingManager?.refresh();
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

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
