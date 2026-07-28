# Project rules

## Versioning and changelog

- MarCat follows semantic `major.minor.patch` versions. The canonical version is the root `package.json`; keep every workspace package version synchronized with it.
- Increase only the patch number by default.
- Never change the major or minor version unless the project owner explicitly approves that exact version increase.
- `npm run package` never changes the version; repeat builds of the current unpublished release keep the same version.
- Follow `RELEASE.md` for the release decision, changelog format, artifact location, retention, rebuild rules, and verification steps.

## UI state persistence

- Every product section must remember the user's working state across navigation and app restarts: the selected record, current view or edit mode, filters and sorting, and collapsed panels when those concepts apply.
- Scope section state to the current project when the choice is project-specific.
- New sections should store these preferences through the shared persisted `sectionViewStates` UI store instead of keeping them only in component-local state.
