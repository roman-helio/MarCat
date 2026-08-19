# Project rules

## Versioning and changelog

- MarCat follows semantic `major.minor.patch` versions. The canonical version is the root `package.json`; keep every workspace package version synchronized with it.
- Increase only the patch number by default.
- Never change the major or minor version unless the project owner explicitly approves that exact version increase.
- `npm run package` never changes the version; repeat builds of the current unpublished release keep the same version.
- Follow `RELEASE.md` for the release decision, changelog format, artifact location, retention, rebuild rules, and verification steps.

## Commits and pushes

- Never commit or push changes unless the project owner explicitly asks for that action.
- Permission to implement, verify, package, or prepare a release does not imply permission to commit or push it.
- Treat commit and push as separate permissions: a request to commit does not authorize a push, and a request to push authorizes only the commits the owner has approved.
- Until approval is given, keep completed work in the local working tree so the project owner can review it first.

## UI state persistence

- Every product section must remember the user's working state across navigation and app restarts: the selected record, current view or edit mode, filters and sorting, and collapsed panels when those concepts apply.
- Scope section state to the current project when the choice is project-specific.
- New sections should store these preferences through the shared persisted `sectionViewStates` UI store instead of keeping them only in component-local state.

## Codex MCP configuration

- Codex merges the global `$CODEX_HOME/config.toml` with the project `.codex/config.toml` by MCP server name. Before adding or changing an `[mcp_servers.<name>]` entry, inspect both layers.
- A server name must use exactly one transport across all layers: `command`/`args` for stdio or `url` for streamable HTTP. Never define `command` in one layer and `url` in another for the same name; the merged config becomes invalid and can prevent Codex from loading any project.
- Keep `marcat` project-local as the stdio entry in `.codex/config.toml`. Do not add a global `mcp_servers.marcat` entry unless the project-local entry is removed or both layers are intentionally replaced with one non-conflicting definition.
- After changing either Codex config layer, run `npm run verify:codex-config` from this repository before restarting Codex.
