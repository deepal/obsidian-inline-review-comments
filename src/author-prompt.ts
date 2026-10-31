import { App, Modal, Platform, Setting } from "obsidian";
import { gitUserName } from "./author";

/**
 * Asks once per vault and device who is commenting. Resolves to the chosen
 * name (`""` for anonymous) or `null` when the dialog is dismissed.
 */
export function promptForAuthor(app: App, suggestion: string): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let value = suggestion;
		let chosen: string | null = null;
		const choose = (name: string) => {
			chosen = name.trim();
			modal.close();
		};

		modal.setTitle("Comment author name");
		modal.contentEl.createEl("p", {
			text: "Added to the comments you write in this vault. It is stored on this device only, so people sharing the vault keep their own names. You can change it in the plugin settings.",
		});
		new Setting(modal.contentEl).setName("Name").addText((text) => {
			text.setPlaceholder("Your name").setValue(suggestion).onChange((next) => { value = next; });
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		new Setting(modal.contentEl)
			.addButton((button) => button.setButtonText("Comment anonymously").onClick(() => choose("")))
			.addButton((button) => button.setButtonText("Save").setCta().onClick(() => choose(value)));
		modal.scope.register([], "Enter", (event) => {
			event.preventDefault();
			choose(value);
		});
		modal.onClose = () => resolve(chosen);
		modal.open();
	});
}

/**
 * Best guess for the prefill: the vault repository's `user.name`, then the
 * global git config on desktop. Returns null when neither has a name.
 */
export async function suggestAuthorName(app: App): Promise<string | null> {
	const fromVault = await readOrNull(() => app.vault.adapter.read(".git/config"));
	const vaultName = fromVault === null ? null : gitUserName(fromVault);
	if (vaultName) return vaultName;

	if (Platform.isDesktop) {
		// The desktop app exposes Node's require on window; bundled import() would not resolve.
		// Node's types are absent from the browser type check, so the used members are declared here.
		const nodeRequire = (window as unknown as { require: (id: string) => unknown }).require;
		const fs = nodeRequire("fs/promises") as { readFile(path: string, encoding: "utf8"): Promise<string> };
		const home = (nodeRequire("os") as { homedir(): string }).homedir();
		// Git reads ~/.config/git/config first and ~/.gitconfig after it, so the latter wins.
		for (const path of [`${home}/.gitconfig`, `${home}/.config/git/config`]) {
			const config = await readOrNull(() => fs.readFile(path, "utf8"));
			const name = config === null ? null : gitUserName(config);
			if (name) return name;
		}
	}
	return null;
}

/** A missing or unreadable config file just means there is no suggestion. */
async function readOrNull(read: () => Promise<string>): Promise<string | null> {
	try {
		return await read();
	} catch {
		return null;
	}
}
