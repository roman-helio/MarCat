# MarCat MCP runtime

- Build callers with both the shared database and a `MarkdownWorkspaceCoordinator`.
- Start the coordinator only after migrations, and stop it during process shutdown.
- All managed writes must go through the shared tRPC routers. SQLite triggers durably enqueue Markdown exports,
  including nested checklist, dependency and tag-link changes; do not add direct filesystem writes to MCP tools.
- A configured Markdown workspace is user-owned data. External deletion becomes a resolvable `missing` issue.
  MarCat deletion moves the last complete document to `Quarantine/Deleted`.
- Workspace paths returned by tools must come from the coordinator's contained-path validation.
