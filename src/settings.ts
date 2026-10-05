import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type InlineReviewCommentPlugin from "./main";
export { DEFAULT_SETTINGS, normalizeSettings, type InlineReviewSettings } from "./settings-data";

export class InlineReviewSettingTab extends PluginSettingTab {
	plugin: InlineReviewCommentPlugin;

	constructor(app: App, plugin: InlineReviewCommentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Show review comments",
				desc: "Render inline comments as review cards in the margin.",
				render: (setting) => {
					setting.addToggle((t) => t.setValue(this.plugin.settings.enabled).onChange(async (value) => {
						this.plugin.settings.enabled = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAll();
					}));
				},
			},
			{
				name: "Comment author name",
				desc: "Added to new comments. Leave blank for anonymous comments.",
				control: { type: "text", key: "username", placeholder: "John Doe" },
			},
			{
				name: "Use the toggle comment shortcut",
				desc: "Make the built-in comment shortcut insert an authored comment. Turn off to restore its original behavior.",
				render: (setting) => {
					setting.addToggle((t) => t.setValue(this.plugin.settings.overrideToggleComment).onChange(async (value) => {
						this.plugin.settings.overrideToggleComment = value;
						await this.plugin.saveSettings();
						this.plugin.applyToggleOverride();
					}));
				},
			},
			{
				name: "Auto-insert author when typing %%",
				desc: "Typing %% expands to a comment with your author name. Undo reverts it to plain markers.",
				control: { type: "toggle", key: "autoInsertOnType" },
			},
			{
				name: "Hide comment markers",
				desc: "Hide markers in live preview except while editing the comment. Source mode is unaffected.",
				render: (setting) => {
					setting.addToggle((t) => t.setValue(this.plugin.settings.hideCommentMarkers).onChange(async (value) => {
						this.plugin.settings.hideCommentMarkers = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAll();
					}));
				},
			},
			{
				name: "Card width",
				desc: "Width of each review card, in pixels.",
				render: (setting) => {
					setting.addSlider((s) => s.setLimits(180, 360, 10).setValue(this.plugin.settings.cardWidth)
						.onChange(async (value) => {
							this.plugin.settings.cardWidth = value;
							await this.plugin.saveSettings();
							this.plugin.refreshAll();
						}));
				},
			},
		];
	}
}
