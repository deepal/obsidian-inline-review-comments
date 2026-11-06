import { Component, setIcon, setTooltip, TFile, TFolder, Vault, type App, type TAbstractFile } from "obsidian";

interface Entry {
	mtime: number;
	size: number;
	present: boolean;
}

const rowSelector = ".nav-file-title[data-path]";
const treeSelector = ".nav-file-title, .nav-file-title-content, .nav-folder";
const indexVersion = 1;
const maxReads = 2;
const rowMountWait = 250;

function matchesStat(entry: Pick<Entry, "mtime" | "size">, file: TFile): boolean {
	return entry.mtime === file.stat.mtime && entry.size === file.stat.size;
}

/** The only component that depends on the built-in File Explorer's markup. */
export class ExplorerBadges extends Component {
	private readonly entries = new Map<string, Entry>();
	private readonly waiting = new Map<string, TFile>();
	private readonly running = new Map<string, Pick<Entry, "mtime" | "size">>();
	private readonly roots = new Map<HTMLElement, MutationObserver>();
	private readonly badges = new Map<HTMLElement, HTMLElement>();
	private readonly changed = new Set<string>();
	private readonly rows = new Map<string, HTMLElement[]>();
	private readonly visible = new Set<string>();
	private generation = 0;
	private ready = false;
	private loadedIndex = false;
	private dirtyIndex = false;
	private reads = 0;
	private startTimer?: number;
	private scanTimer?: number;
	private saveTimer?: number;
	private frame?: number;
	private treeChanged = false;

	constructor(
		private readonly app: App,
		private readonly storageKey: string,
		private readonly badgeClass: string,
		private readonly icon: string,
		private readonly label: string,
		private readonly hasComments: (text: string) => boolean,
	) { super(); }

	private get win(): Window { return this.app.workspace.containerEl.win; }

	setEnabled(enabled: boolean): void {
		if (enabled) this.load();
		else this.unload();
	}

	onload(): void {
		const generation = ++this.generation;
		const { workspace, vault } = this.app;
		workspace.onLayoutReady(() => {
			if (generation !== this.generation) return;
			this.ready = true;
			this.restoreIndex();
			const files = vault.getMarkdownFiles();
			const paths = new Set(files.map(file => file.path));
			for (const path of this.entries.keys()) {
				if (!paths.has(path)) this.forget(path);
			}
			for (const file of files) {
				const entry = this.entries.get(file.path);
				if (entry && matchesStat(entry, file)) continue;
				this.forget(file.path);
				this.waiting.set(file.path, file);
			}
			this.registerEvent(vault.on("create", file => this.refresh(file)));
			this.registerEvent(vault.on("modify", file => this.refresh(file)));
			this.registerEvent(vault.on("delete", file => this.forgetTree(file, file.path)));
			this.registerEvent(vault.on("rename", (file, oldPath) => {
				this.forgetTree(file, oldPath);
				if (file instanceof TFolder) Vault.recurseChildren(file, child => this.refresh(child));
				else this.refresh(file);
			}));
			this.registerEvent(workspace.on("layout-change", this.scheduleTree));
			this.registerEvent(workspace.on("window-open", this.scheduleTree));
			this.registerEvent(workspace.on("window-close", this.scheduleTree));
			// Give the explorer time to mount its virtual rows, even if paint is delayed.
			if (this.waiting.size) this.startTimer = this.win.setTimeout(this.startScan, rowMountWait);
			this.scheduleTree();
		});
	}

	onunload(): void {
		this.generation++;
		this.ready = false;
		if (this.startTimer !== undefined) this.win.clearTimeout(this.startTimer);
		if (this.scanTimer !== undefined) this.win.clearTimeout(this.scanTimer);
		if (this.saveTimer !== undefined) this.win.clearTimeout(this.saveTimer);
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		this.startTimer = this.scanTimer = this.saveTimer = this.frame = undefined;
		this.flushIndex();
		this.waiting.clear();
		this.running.clear();
		this.changed.clear();
		this.treeChanged = false;
		this.rows.clear();
		this.visible.clear();
		for (const observer of this.roots.values()) observer.disconnect();
		this.roots.clear();
		for (const badge of this.badges.values()) badge.remove();
		this.badges.clear();
	}

	private restoreIndex(): void {
		if (this.loadedIndex) return;
		this.loadedIndex = true;
		try {
			const raw = this.app.loadLocalStorage(this.storageKey) as { version?: unknown; entries?: unknown } | null;
			if (raw?.version !== indexVersion || !Array.isArray(raw.entries)) return;
			for (const row of raw.entries as unknown[]) {
				if (!Array.isArray(row)) continue;
				const [path, mtime, size, present] = row as unknown[];
				if (typeof path === "string" && typeof mtime === "number" && Number.isFinite(mtime) &&
					typeof size === "number" && Number.isFinite(size) && typeof present === "boolean") {
					this.entries.set(path, { mtime, size, present });
				}
			}
		} catch {
			// Device storage is optional. The session still uses the in-memory index.
		}
	}

	private markIndexDirty(): void {
		this.dirtyIndex = true;
		this.saveTimer ??= this.win.setTimeout(() => {
			this.saveTimer = undefined;
			this.flushIndex();
		}, 1000);
	}

	private flushIndex(): void {
		if (!this.dirtyIndex) return;
		this.dirtyIndex = false;
		try {
			const entries = Array.from(this.entries, ([path, { mtime, size, present }]) => [path, mtime, size, present]);
			this.app.saveLocalStorage(this.storageKey, { version: indexVersion, entries });
		} catch {
			// Quota or storage errors must not prevent badges from working.
		}
	}

	private refresh(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		this.forget(file.path);
		this.waiting.set(file.path, file);
		this.scheduleScan();
	}

	private forgetTree(file: TAbstractFile, path: string): void {
		if (file instanceof TFolder) {
			const prefix = path + "/";
			for (const paths of [this.entries, this.waiting, this.running]) {
				for (const child of paths.keys()) if (child.startsWith(prefix)) this.forget(child);
			}
		} else this.forget(path);
	}

	private forget(path: string): void {
		this.waiting.delete(path);
		this.running.delete(path);
		const entry = this.entries.get(path);
		if (!entry) return;
		this.entries.delete(path);
		this.markIndexDirty();
		if (entry.present) this.schedulePath(path);
	}

	private scheduleScan(): void {
		if (!this.ready || this.startTimer !== undefined || this.scanTimer !== undefined || !this.waiting.size || this.reads >= maxReads) return;
		this.scanTimer = this.win.setTimeout(() => {
			this.scanTimer = undefined;
			const slots = maxReads - this.reads;
			for (let slot = 0; slot < slots && this.waiting.size; slot++) {
				const path = Array.from(this.visible).find(candidate => this.waiting.has(candidate))
					?? this.waiting.keys().next().value;
				if (path === undefined) break;
				const file = this.waiting.get(path);
				this.waiting.delete(path);
				if (file && this.app.vault.getFileByPath(path) === file) void this.scan(file, path);
			}
			this.scheduleScan();
		}, 0);
	}

	private startScan = (): void => {
		if (this.startTimer !== undefined) this.win.clearTimeout(this.startTimer);
		this.startTimer = undefined;
		this.scheduleScan();
	};

	private async scan(file: TFile, path: string): Promise<void> {
		const stamp = { mtime: file.stat.mtime, size: file.stat.size };
		this.running.set(path, stamp);
		this.reads++;
		try {
			const text = await this.app.vault.cachedRead(file);
			if (this.running.get(path) !== stamp || this.app.vault.getFileByPath(path) !== file) return;
			if (!matchesStat(stamp, file)) {
				this.waiting.set(path, file);
				return;
			}
			const present = this.hasComments(text);
			this.entries.set(path, { ...stamp, present });
			this.markIndexDirty();
			if (present) this.schedulePath(path);
		} catch {
			// Retry unreadable files on their next vault event or on re-enable.
		} finally {
			if (this.running.get(path) === stamp) this.running.delete(path);
			this.reads--;
			this.scheduleScan();
		}
	}

	private scheduleTree = (): void => {
		if (!this.ready) return;
		this.treeChanged = true;
		this.schedulePaint();
	};

	private schedulePath(path: string): void {
		if (!this.rows.has(path)) return;
		this.changed.add(path);
		this.schedulePaint();
	}

	private schedulePaint(): void {
		this.frame ??= this.win.requestAnimationFrame(() => {
			this.frame = undefined;
			if (this.treeChanged) {
				this.treeChanged = false;
				this.reconcileTree();
				if (!this.roots.size || this.rows.size) this.startScan();
			} else {
				for (const path of this.changed) {
					for (const title of this.rows.get(path) ?? []) this.paint(path, title);
				}
			}
			this.changed.clear();
		});
	}

	private reconcileTree(): void {
		const roots = new Set(this.app.workspace.getLeavesOfType("file-explorer")
			.map(leaf => leaf.view.containerEl).filter(root => root.isConnected && !root.win.closed));
		for (const [root, observer] of this.roots) {
			if (roots.has(root)) continue;
			observer.disconnect();
			this.roots.delete(root);
		}

		this.rows.clear();
		this.visible.clear();
		const titles = new Set<HTMLElement>();
		for (const root of roots) {
			if (!this.roots.has(root)) {
				const win = root.ownerDocument.defaultView;
				if (!win) continue;
				const observer = new win.MutationObserver(mutations => {
					if (mutations.some(mutation => this.affectsTree(mutation))) this.scheduleTree();
				});
				observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "data-path"] });
				this.roots.set(root, observer);
			}
			const viewport = (root.querySelector(".nav-files-container") ?? root).getBoundingClientRect();
			for (const row of Array.from(root.querySelectorAll<HTMLElement>(rowSelector))) {
				const path = row.dataset.path;
				const title = row.querySelector<HTMLElement>(":scope > .nav-file-title-content");
				if (!path || !title || row.closest(".nav-folder.is-collapsed")) continue;
				const list = this.rows.get(path) ?? [];
				list.push(title);
				this.rows.set(path, list);
				titles.add(title);
				if (!this.waiting.has(path)) continue;
				const bounds = row.getBoundingClientRect();
				if (bounds.height && viewport.height && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
					this.visible.add(path);
				}
			}
		}
		for (const [title, badge] of this.badges) {
			if (titles.has(title)) continue;
			badge.remove();
			this.badges.delete(title);
		}
		for (const [path, rows] of this.rows) {
			for (const title of rows) this.paint(path, title);
		}
	}

	private affectsTree(mutation: MutationRecord): boolean {
		if (mutation.type === "attributes") {
			return (mutation.target as Element).matches(mutation.attributeName === "class" ? ".nav-folder" : treeSelector);
		}
		const row = mutation.target as Element;
		if (row.matches(rowSelector)) {
			const title = row.querySelector<HTMLElement>(":scope > .nav-file-title-content");
			const badge = title && this.badges.get(title);
			if (badge && badge.parentElement !== row) return true;
		}
		return Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some(node => {
			if (node.nodeType !== Node.ELEMENT_NODE) return false;
			const el = node as Element;
			return el.matches(treeSelector) || !!el.querySelector(treeSelector);
		});
	}

	private paint(path: string, title: HTMLElement): void {
		const row = title.parentElement;
		if (!row || !title.isConnected || row.dataset.path !== path || row.closest(".nav-folder.is-collapsed")) return;
		let badge = this.badges.get(title);
		for (const orphan of Array.from(row.querySelectorAll(`:scope > .${this.badgeClass}`))) {
			if (orphan !== badge) orphan.remove();
		}
		if (!this.entries.get(path)?.present) {
			badge?.remove();
			this.badges.delete(title);
		} else if (badge?.parentElement !== row) {
			badge?.remove();
			badge = title.createSpan({ cls: this.badgeClass, attr: { role: "img", "aria-label": this.label } });
			title.after(badge);
			setIcon(badge, this.icon);
			setTooltip(badge, this.label);
			this.badges.set(title, badge);
		}
	}
}
