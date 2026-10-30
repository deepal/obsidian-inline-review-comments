import { App, Component, Notice, Scope, setIcon } from "obsidian";
import type { ComposerDraft } from "./drafts";

interface ComposerOptions {
	edit?: boolean;
	onSaved?: () => void;
	onCancel?: () => void;
}

/** Shared initial-comment/reply form. All resources belong to the card owner. */
export function buildComposer(parent: HTMLElement, app: App, owner: Component, draft: ComposerDraft, initial: boolean, post: (text: string) => Promise<boolean>, escape: () => void, options: ComposerOptions = {}): HTMLElement {
	const box = parent.createDiv({ cls: `irc-composer ${options.edit ? "irc-edit-composer" : initial ? "irc-initial" : "irc-reply"}` });
	box.dataset.ircComposerKey = draft.key;
	const input = box.createEl("textarea", {
		cls: "irc-reply-input",
		attr: { rows: initial ? "3" : "1", placeholder: options.edit ? "Edit comment…" : initial ? "Write a comment…" : "Reply…", "aria-label": options.edit ? "Edit comment" : initial ? "Write a comment" : "Write a reply" },
	});
	const actions = options.edit ? box.createDiv({ cls: "irc-edit-actions" }) : box;
	const send = actions.createEl("button", {
		cls: options.edit ? "irc-reply-send irc-edit-save" : "irc-reply-send",
		text: options.edit ? "Save" : undefined,
		attr: { "aria-label": options.edit ? "Save comment" : initial ? "Post comment" : "Send reply", title: options.edit ? "Save (Cmd/Ctrl+Enter)" : "Post (Cmd/Ctrl+Enter)", type: "button" },
	});
	if (!options.edit) setIcon(send, "send-horizontal");
	const cancel = options.onCancel ? actions.createEl("button", { cls: "irc-edit-cancel", text: "Cancel", attr: { "aria-label": "Cancel edit", type: "button" } }) : undefined;
	if (cancel) owner.registerDomEvent(cancel, "click", () => { if (!draft.submitting) options.onCancel?.(); });
	let disposed = false;
	let composing = false;
	const resize = () => {
		if (disposed || !input.isConnected || input.clientWidth === 0) return;
		// Reset first so deleting text shrinks the field. scrollHeight includes
		// padding; add the borders because the input uses border-box sizing.
		input.setCssProps({ height: "auto" });
		input.setCssProps({ height: `${input.scrollHeight + input.offsetHeight - input.clientHeight}px` });
	};
	const capture = () => draft.update(input.value, input.selectionStart, input.selectionEnd, input.selectionDirection);
	const paint = () => {
		if (input.value !== draft.text) {
			input.value = draft.text;
			input.setSelectionRange(draft.start, draft.end, draft.direction);
		}
		input.disabled = send.disabled = draft.submitting || box.classList.contains("aio-mention-composer-busy");
		if (cancel) cancel.disabled = draft.submitting;
		box.setAttribute("aria-busy", String(draft.submitting));
		resize();
	};
	paint();
	input.setSelectionRange(draft.start, draft.end, draft.direction);
	owner.register(draft.subscribe(paint));
	owner.register(() => { disposed = true; });
	let width = -1;
	let resizeFrame: number | undefined;
	const resizeObserver = new ResizeObserver(() => {
		// Height changes are ours; only width changes can alter line wrapping.
		if (disposed || input.clientWidth === width) return;
		width = input.clientWidth;
		// Changing an observed textarea's height during delivery creates a
		// ResizeObserver feedback warning. Resize on its owning window's frame.
		if (resizeFrame === undefined) resizeFrame = input.win.requestAnimationFrame(() => {
			resizeFrame = undefined;
			resize();
		});
	});
	resizeObserver.observe(input);
	owner.register(() => {
		resizeObserver.disconnect();
		if (resizeFrame !== undefined) input.win.cancelAnimationFrame(resizeFrame);
	});
	for (const event of ["input", "select", "keyup", "click", "blur"] as const) owner.registerDomEvent(input, event, capture);
	owner.registerDomEvent(input, "compositionstart", () => { composing = true; });
	owner.registerDomEvent(input, "compositionend", () => { composing = false; capture(); });

	const submit = async () => {
		if (disposed || composing || input.disabled || send.disabled || draft.submitting) return;
		capture();
		const text = draft.text.trim();
		if (!text) return;
		draft.busy(true);
		try {
			if (!await post(text)) throw new Error("The comment changed or was removed.");
			draft.clear();
			options.onSaved?.();
		} catch {
			new Notice("Could not save the comment. Your draft has been kept.");
		} finally {
			draft.busy(false);
		}
	};
	owner.registerDomEvent(send, "click", (event) => { event.preventDefault(); void submit(); });
	const submitKey = (event: KeyboardEvent) => {
		if (composing || event.isComposing) return;
		event.preventDefault();
		event.stopPropagation();
		if (!event.repeat) void submit();
		return false;
	};
	const escapeKey = (event: KeyboardEvent) => {
		if (composing || event.isComposing) return;
		event.preventDefault();
		event.stopPropagation();
		capture();
		escape();
		return false;
	};
	const scope = new Scope(app.scope);
	for (const modifier of ["Meta", "Ctrl"] as const) scope.register([modifier], "Enter", submitKey);
	scope.register([], "Escape", escapeKey);
	let active = false;
	const deactivate = () => {
		if (active) { active = false; app.keymap.popScope(scope); }
	};
	owner.registerDomEvent(input, "focus", () => {
		if (!active) { active = true; app.keymap.pushScope(scope); }
	});
	owner.registerDomEvent(input, "blur", deactivate);
	owner.register(deactivate);
	owner.registerDomEvent(input, "keydown", (event) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) submitKey(event);
		else if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) escapeKey(event);
	});
	return box;
}
