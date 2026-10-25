# Contributing

Bug reports, ideas, and pull requests are welcome.

## Issues

Report bugs and suggest improvements in
[GitHub Issues](https://github.com/deepal/obsidian-inline-review-comments/issues).
For display problems, include your Obsidian version, theme, view mode, and a
small example note that reproduces the issue.

## Pull requests

1. Set up the project as described in the README's
   [Development](./README.md#development) section.
2. Keep each pull request focused on one change, and add or update tests in
   `test/` for behavior you change.
3. Before opening the pull request, run the same checks as CI:

   ```bash
   npm run lint
   npm test
   npm run build
   ```

4. Use a [Conventional Commit](https://www.conventionalcommits.org/) as the
   pull request title, for example `fix: keep cards aligned in tables`. Pull
   requests are squash-merged, and the title determines the next release. See
   [Versioning and releases](./README.md#versioning-and-releases).
5. Leave version numbers, `CHANGELOG.md`, and `versions.json` unchanged. The
   release workflow updates them.

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
