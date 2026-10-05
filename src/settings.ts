import { App, PluginSettingTab, Setting } from "obsidian";
import type InlineReviewCommentPlugin from "./main";

export interface InlineReviewSettings {
	enabled: boolean;
	cardWidth: number;
	hideCommentMarkers: boolean;
	username: string;
	autoInsertOnType: boolean;
	overrideToggleComment: boolean;
}

export const DEFAULT_SETTINGS: InlineReviewSettings = {
	enabled: true,
	cardWidth: 240,
	hideCommentMarkers: true,
	username: "",
	autoInsertOnType: true,
	overrideToggleComment: true,
};

export class InlineReviewSettingTab extends PluginSettingTab {
	plugin: InlineReviewCommentPlugin;

	constructor(app: App, plugin: InlineReviewCommentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Show review comments")
			.setDesc("Render %% comments %% as review cards in the right margin.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await this.plugin.saveSettings();
					this.plugin.refreshAll();
				})
			);

		new Setting(containerEl)
			.setName("Comment author name")
			.setDesc(
				"Inserted as %% ::name:: ... %% by the “Insert comment” command. Leave blank for anonymous comments. Assign a hotkey to the command in Settings → Hotkeys."
			)
			.addText((t) =>
				t
					.setPlaceholder("e.g. John Doe")
					.setValue(this.plugin.settings.username)
					.onChange(async (v) => {
						this.plugin.settings.username = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Use “Toggle comment” shortcut (Cmd/Ctrl+/)")
			.setDesc(
				"Make the built-in Toggle comment command insert an authored comment instead, so its existing shortcut adds your name. Turn off to restore the default toggle behaviour."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.overrideToggleComment)
					.onChange(async (v) => {
						this.plugin.settings.overrideToggleComment = v;
						await this.plugin.saveSettings();
						if (v) this.plugin.applyToggleOverride();
						else this.plugin.restoreToggleOverride();
					})
			);

		new Setting(containerEl)
			.setName("Auto-insert author when typing %%")
			.setDesc(
				"Typing %% expands to a full comment with your author name and the cursor in the body. Undo (Ctrl/Cmd+Z) reverts to a plain %%."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoInsertOnType).onChange(async (v) => {
					this.plugin.settings.autoInsertOnType = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Hide comment markers in Live Preview")
			.setDesc(
				"Hide the %% markers in Live Preview (they reappear when your cursor is inside the comment). Source mode is unaffected."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hideCommentMarkers).onChange(async (v) => {
					this.plugin.settings.hideCommentMarkers = v;
					await this.plugin.saveSettings();
					this.plugin.refreshAll();
				})
			);

		new Setting(containerEl)
			.setName("Card width")
			.setDesc("Width of each review card, in pixels.")
			.addSlider((s) =>
				s
					.setLimits(180, 360, 10)
					.setValue(this.plugin.settings.cardWidth)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.cardWidth = v;
						await this.plugin.saveSettings();
						this.plugin.refreshAll();
					})
			);
	}
}
