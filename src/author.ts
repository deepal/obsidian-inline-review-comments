/**
 * The comment author for this vault on this device. Kept in Obsidian's
 * vault-scoped localStorage instead of data.json, because data.json travels
 * with the vault (git, Obsidian Sync, iCloud) and would give everyone sharing
 * the vault the same name.
 */

/** The subset of Obsidian's `App` used for storage, so tests can fake it. */
export interface LocalStorageHost {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

export class AuthorStore {
	private readonly host: LocalStorageHost;
	private readonly key: string;

	constructor(host: LocalStorageHost, key: string) {
		this.host = host;
		this.key = key;
	}

	/**
	 * The name chosen on this device; `""` means anonymous by choice and
	 * `null` that no choice was made yet.
	 */
	get(): string | null {
		const raw = this.host.loadLocalStorage(this.key);
		if (raw === null || typeof raw !== "object") return null;
		const name = (raw as Record<string, unknown>).name;
		return typeof name === "string" ? name : null;
	}

	/**
	 * Stored as an object: Obsidian deletes the entry for falsy values, which
	 * would turn "anonymous" back into "not chosen yet".
	 */
	set(name: string): void {
		this.host.saveLocalStorage(this.key, { name: name.trim() });
	}
}

/**
 * Reads `user.name` from a git config file. Like git, the last value wins.
 * Input:  "[core]\n\tbare = false\n[user]\n\tname = \"Ada Lovelace\" ; me\n"
 * Output: "Ada Lovelace"
 */
export function gitUserName(config: string): string | null {
	let inUser = false;
	let name: string | null = null;
	for (const line of config.split(/\r?\n/)) {
		// Section headers: "[user]", but not "[user "sub"]" or "[core]".
		const section = /^\s*\[([^\]\s"]+)\s*\]/.exec(line);
		if (section) {
			inUser = section[1].toLowerCase() === "user";
			continue;
		}
		if (/^\s*\[/.test(line)) {
			inUser = false;
			continue;
		}
		if (!inUser) continue;
		// "name = value" with an optional quoted value and trailing ; or # comment.
		const entry = /^\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;#]*))/i.exec(line);
		if (entry) name = (entry[1]?.replace(/\\(.)/g, "$1") ?? entry[2]).trim();
	}
	return name || null;
}
