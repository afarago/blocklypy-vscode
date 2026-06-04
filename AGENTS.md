# AGENTS

Repository rule for coding agents and automation:

- Before making code changes, update the `## [Unreleased]` section in CHANGELOG.md.
- Keep a short, user-facing bullet list of changes grouped under headings like Added, Changed, Fixed, Refactor.
- Do not publish with an empty `## [Unreleased]` section.

Release flow notes:

- `yarn publish` is guarded by `prepublishOnly` and runs `npm run changelog:check`.
- `yarn publish-extension` and `yarn publish-extension-with-patch` also run `npm run changelog:check` before `vsce publish`.
