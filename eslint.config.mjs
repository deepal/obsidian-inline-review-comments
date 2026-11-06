import obsidianmd from "eslint-plugin-obsidianmd";

const restrictedGlobals = obsidianmd.configs.recommended.find(
	(config) => config.rules?.["no-restricted-globals"],
).rules["no-restricted-globals"];

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/gravatar.ts"],
		// Gravatar supports CORS. Fetch can abort a stalled or obsolete lookup.
		rules: { "no-restricted-globals": restrictedGlobals.filter((entry) => entry.name !== "fetch") },
	},
	{
		files: ["src/**/*.ts"],
		// Text-cursor references must not be capitalized as the Cursor product.
		rules: { "obsidianmd/ui/sentence-case": ["warn", { ignoreRegex: ["^Insert comment at cursor$"] }] },
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
	{
		files: ["src/settings.ts"],
		rules: {
			// Keep the published plugin name and the example agent tag intact.
			"obsidianmd/ui/sentence-case": ["warn", { ignoreWords: ["Overview"], ignoreRegex: ["^@Atlas$"] }],
		},
	},
];
