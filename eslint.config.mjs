import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		// Text-cursor references must not be capitalized as the Cursor product.
		rules: { "obsidianmd/ui/sentence-case": ["warn", { ignoreRegex: ["^Insert comment at cursor$"] }] },
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
];
