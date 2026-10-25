import { App, PluginSettingTab, type Events, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { BRIDGE_CHANGED, BRIDGE_DISCOVER, LEGACY_BRIDGE_CHANGED, LEGACY_BRIDGE_DISCOVER, isAgentBridge } from "./agent-bridge.ts";
import type InlineReviewCommentPlugin from "./main";
export { DEFAULT_SETTINGS, legacyUsername, normalizeSettings, type InlineReviewSettings } from "./settings-data";

const AUTHOR_CONTROL = "author";

export class InlineReviewSettingTab extends PluginSettingTab {
	plugin: InlineReviewCommentPlugin;

	constructor(app: App, plugin: InlineReviewCommentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		for (const event of [BRIDGE_CHANGED, LEGACY_BRIDGE_CHANGED]) {
			plugin.registerEvent((app.workspace as Events).on(event, () => {
				if (this.containerEl?.isConnected) this.refreshDomState();
			}));
		}
	}

	/** The author lives in device-local storage (see author.ts), not in `plugin.settings`. */
	getControlValue(key: string): unknown {
		return key === AUTHOR_CONTROL ? this.plugin.author.get() ?? "" : super.getControlValue(key);
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		if (key !== AUTHOR_CONTROL) return super.setControlValue(key, value);
		this.plugin.author.set(typeof value === "string" ? value : "");
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const general: SettingDefinition[] = [
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
				desc: "Added to new comments. Stored on this device for this vault only, so people sharing the vault keep their own names. Leave blank for anonymous comments.",
				control: { type: "text", key: AUTHOR_CONTROL, placeholder: "John Doe" },
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
		return [
			{
				type: "group",
				heading: "AI Agents",
				visible: () => {
					const visible = !this.hasConfiguredAgent();
					this.containerEl?.classList.toggle("irc-settings-agent-ready", !visible);
					return visible;
				},
				items: [{
					name: "Agent mentions",
					desc: this.agentDescription().textContent ?? "",
					aliases: ["AI Overview", "agent name tag", "agent mentions"],
					render: (setting) => {
						setting.setName("");
						setting.setDesc(this.agentDescription());
					},
				}],
			},
			{ type: "group", heading: "General", cls: "irc-settings-general", items: general },
		];
	}

	private hasConfiguredAgent(): boolean {
		let ready = false;
		for (const [event, version] of [[BRIDGE_DISCOVER, 2], [LEGACY_BRIDGE_DISCOVER, 1]] as const) {
			if (ready) break;
			(this.app.workspace as Events).trigger(event, (candidate: unknown) => {
				if (isAgentBridge(candidate, version) && candidate.tag.trim()) ready = true;
			});
		}
		return ready;
	}

	private agentDescription(): DocumentFragment {
		const description = createFragment();
		description.append("Work with your AI agent directly from review comments with ");
		description.createEl("a", {
			text: "AI Overview",
			href: "https://community.obsidian.md/plugins/ai-overview",
			attr: { target: "_blank", rel: "noopener noreferrer" },
		});
		description.append(". Install and enable the plugin on desktop, configure your agent under ");
		description.createEl("strong", { text: "Settings → AI Overview" });
		description.append(", and set an ");
		description.createEl("strong", { text: "Agent name tag" });
		description.append(" (e.g. ");
		description.createEl("code", { text: "Atlas" });
		description.append("). Then mention ");
		description.createEl("code", { text: "@Atlas" });
		description.append(" in an inline review comment or reply to request any task the agent can complete with its existing tools and permissions, without additional approval. The agent carries out the work and posts its response in the same thread.");
		return description;
	}
}
