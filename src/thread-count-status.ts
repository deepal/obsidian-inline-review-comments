import { Component, MarkdownView, Platform, setTooltip, type Plugin, type TAbstractFile } from "obsidian";
import { groupComments, parseComments } from "./parser";

/** Counts the active note, independently of margin-card visibility and lifetime. */
export class ThreadCountStatus extends Component {
	private item?: HTMLElement;
	private timer?: number;
	private revision = 0;
	private disposed = false;
	private displayedView?: MarkdownView;
	private displayedPath?: string;

	constructor(private readonly plugin: Plugin) { super(); }

	onload(): void {
		if (Platform.isMobile) return;
		this.item = this.plugin.addStatusBarItem();
		this.item.addClass("irc-thread-count");
		this.item.hide();

		const { workspace, vault } = this.plugin.app;
		this.registerEvent(workspace.on("active-leaf-change", this.schedule));
		this.registerEvent(workspace.on("file-open", this.schedule));
		this.registerEvent(workspace.on("layout-change", this.schedule));
		this.registerEvent(workspace.on("editor-change", (_editor, info) => {
			// Embedded table-cell editors can emit partial documents. Read the
			// owning MarkdownView instead of the event's editor argument.
			if (info.file && info.file === this.activeView()?.file) this.schedule();
		}));
		const fileChanged = (file: TAbstractFile) => {
			if (file === this.activeView()?.file) this.schedule();
		};
		this.registerEvent(vault.on("modify", fileChanged));
		this.registerEvent(vault.on("rename", fileChanged));
		this.registerEvent(vault.on("delete", fileChanged));
		workspace.onLayoutReady(this.schedule);
	}

	private activeView(): MarkdownView | null {
		return this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
	}

	/** Invalidate pending reads immediately, then coalesce changes into one update. */
	private schedule = (): void => {
		if (this.disposed || !this.item) return;
		this.revision++;
		const view = this.activeView();
		if (!view?.file || view !== this.displayedView || view.file.path !== this.displayedPath) this.item.hide();
		if (this.timer !== undefined) return;
		this.timer = window.setTimeout(() => {
			this.timer = undefined;
			void this.refresh();
		}, 75);
	};

	private async refresh(): Promise<void> {
		const item = this.item;
		const view = this.activeView();
		const file = view?.file;
		if (this.disposed || !item || !view || !file) return;
		const revision = this.revision;
		const path = file.path;
		const mode = view.getMode();
		const current = () => !this.disposed && revision === this.revision &&
			this.activeView() === view && view.file === file && file.path === path && view.getMode() === mode;
		try {
			const text = mode === "source" ? view.getViewData() : await this.plugin.app.vault.cachedRead(file);
			if (!current()) return;
			const count = groupComments(parseComments(text), text).length;
			item.setText(`${count} ${count === 1 ? "thread" : "threads"}`);
			setTooltip(item, `Review threads in ${path}`);
			this.displayedView = view;
			this.displayedPath = path;
			item.show();
		} catch (error) {
			if (current()) {
				item.hide();
				console.error("[inline-review-comment] Could not count review threads", error);
			}
		}
	}

	onunload(): void {
		this.disposed = true;
		this.revision++;
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.item?.remove();
	}
}
