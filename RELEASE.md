# MarCat release manifest

This file is the canonical release process for maintainers and coding agents.

## Canonical version

- The root `package.json` is the source of truth. Every workspace package and the lockfile must use the same version.
- Running `npm run package` never changes the version. The current version may be rebuilt any number of times while it is being prepared or checked.
- Increment the patch number only when declaring a new user-visible release after the previous version has been published.
- Never change the major or minor number without the project owner's explicit approval of that exact increase.
- A version becomes published when its artifacts are given to users or the project owner explicitly marks it as released.
- Rebuild a published version only to reproduce missing or corrupted artifacts from the same source and release contents. Any new user-visible behavior after publication belongs to the next patch release.

| Situation                                                                              | Version action                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------- |
| Local work, QA build, packaging check, or correction before publication                | Rebuild the current version              |
| Missing or corrupted artifact with unchanged source and release contents               | Rebuild the same version                 |
| Accumulated user-visible changes ready to ship after the current version was published | Increment patch once                     |
| Proposed minor or major release                                                        | Wait for explicit project-owner approval |

## Changelog

- `CHANGELOG.md` is the source of truth and is written in Russian for users.
- Keep sections in descending version order. Each version has a release date and comparison base.
- Use only the applicable headings: `Добавлено`, `Изменено`, `Исправлено`, `Удалено`.
- Describe user-visible outcomes. Do not list commits, internal refactors, file names, or implementation trivia.
- While a version is unpublished, update its existing section as the release contents change. After publication, do not rewrite that section; add changes to the next patch section.

```markdown
## 0.3.7 — YYYY-MM-DD

База сравнения: 0.3.6.

### Добавлено

- Пользовательский результат.

### Исправлено

- Пользовательский результат.
```

## Build and artifact location

Run the complete release pipeline from the repository root:

```powershell
npm run package
```

The only retained output is:

```text
apps/desktop/release/MarCat-<version>/
  CHANGELOG.md
  MarCat-<version>-portable.exe
  MarCat-Setup-<version>.exe
  README-RU.md
  SHA256SUMS.txt
```

- The directory above is the complete release and the only thing to archive or upload.
- Both executables are stored once. There are no duplicate copies in the release root.
- Intermediate Electron Builder output is created under `apps/desktop/release/.build` and removed after successful verification.
- A successful build removes all older releases. Until the candidate passes verification, the last successful release remains in place.
- `SHA256SUMS.txt` contains SHA-256 checksums for both executables.

## Completion criteria

A release build is complete only when the pipeline has:

1. verified synchronized versions and the changelog section;
2. verified public release data;
3. built the packages, MCP server, desktop app, installer, and portable executable;
4. checked the packaged application for private runtime data and required resources;
5. verified both executable checksums;
6. replaced the release output with the single `MarCat-<version>` directory.

If any step fails, do not call the release complete. Fix the cause and rerun `npm run package` without increasing the version unless the versioning rules above require it.
