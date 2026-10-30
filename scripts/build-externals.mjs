import { builtinModules } from "node:module";

// These modules are supplied by Obsidian. Keep both forms of Node built-ins
// external, including prefix-only modules absent from builtinModules.
export const externalModules = [
	"obsidian", "electron",
	"@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
	"@codemirror/language", "@codemirror/lint", "@codemirror/search",
	"@codemirror/state", "@codemirror/view",
	"@lezer/common", "@lezer/highlight", "@lezer/lr",
	...new Set(builtinModules.flatMap((name) => [name, `node:${name.replace(/^node:/, "")}`])),
	"node:*",
];
