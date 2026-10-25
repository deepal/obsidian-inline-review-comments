import { editorInfoField, type Editor } from "obsidian";
import { EditorView } from "@codemirror/view";

/** Obsidian's table editors share editorInfoField with the full-note editor.
 * Keep access to its private CodeMirror handles in this guarded adapter. */
function handles(editor: Editor | undefined): { cm?: EditorView; activeCM?: EditorView } {
	const host: unknown = editor;
	const isView = (value: unknown): value is EditorView => !!value && typeof value === "object" &&
		"state" in value && "dom" in value && "dispatch" in value && typeof value.dispatch === "function";
	if (!host || typeof host !== "object") return {};
	const cm = "cm" in host && isView(host.cm) ? host.cm : undefined;
	const component = "editorComponent" in host ? host.editorComponent : undefined;
	const activeCM = component && typeof component === "object" && "activeCM" in component && isView(component.activeCM) ? component.activeCM : undefined;
	return { cm, activeCM };
}

/** Null means a detached editor cannot yet be classified safely. */
export function owningNoteView(view: EditorView): EditorView | null {
	const canonical = handles(view.state.field(editorInfoField, false)?.editor).cm;
	if (canonical) return canonical;
	if (!view.dom.isConnected) return null;
	let owner = view;
	let parent = view.dom.parentElement?.closest<HTMLElement>(".cm-editor");
	while (parent) {
		const candidate = EditorView.findFromDOM(parent);
		if (!candidate) return null;
		owner = candidate;
		parent = parent.parentElement?.closest<HTMLElement>(".cm-editor");
	}
	return owner;
}

export function activeEditorView(owner: EditorView): EditorView {
	const active = handles(owner.state.field(editorInfoField, false)?.editor).activeCM;
	if (active && (active === owner || owningNoteView(active) === owner)) return active;
	const focused = owner.dom.ownerDocument.activeElement;
	const editor = focused?.closest<HTMLElement>(".cm-editor");
	const candidate = editor ? EditorView.findFromDOM(editor) : null;
	return candidate && owningNoteView(candidate) === owner ? candidate : owner;
}
