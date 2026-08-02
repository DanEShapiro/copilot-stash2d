# Copilot Stash2D

Copilot Stash2D exports a GitHub Copilot CLI session into a portable, editable folder that can be stored offline, shared, and applied to a new session. It never resumes or depends on the original session.

It is the successor to [git-stash2d](https://github.com/DanEShapiro/git-stash2d). “2D” means “to directory”: both tools move system-owned state into human-readable files.

## Install

```shell
copilot plugin install DanEShapiro/copilot-stash2d
```

To load a local checkout during development:

```shell
copilot --plugin-dir "/path/to/copilot-stash2d"
```

If the commands are unavailable, run `/experimental on`, then restart Copilot.

## Save

```text
/stash2d-save
```

Stash2D asks for a name and destination, then exports the session through Copilot's public API. `/share` is not required.

Values can also be supplied inline:

```text
/stash2d-save --output "~/Downloads" --title "weather API investigation"
```

Stash2D may offer to include referenced external files. Git-repository files, Copilot internals, and the active session workspace are excluded.

## Apply

```text
/stash2d-apply "/path/to/archive"
```

Run this in a new session. Stash2D attaches the archive and asks Copilot to reconstruct the prior working state; archived instructions are not executed automatically.

## Archive format

```text
YYYY-MM-DD HH.mm.ss - copilot-stash2d - title/
├── Session.md
├── Handoff.md
├── Metadata.json
├── SessionState/
│   └── plan.md
├── SessionFiles/
│   └── ...
└── Context/
    └── ...
```

- `Session.md` contains the readable session history.
- `Handoff.md` summarizes the working state and next steps.
- `SessionState/plan.md` preserves the plan or contains a generated continuation plan.
- `SessionFiles/` contains session artifacts.
- `Context/` contains approved external files.

Subagent internals are omitted; their returned results remain in the main history. Archives are editable and have no integrity hashes. Review them for sensitive content before sharing.

## Boundaries

- Stash2D uses public extension APIs and does not read Copilot's private session database.
- Plans and artifacts require the SDK's `session.workspacePath`.
- Large archives may exceed a model's context window.
- The extension API may differ between Copilot CLI versions.

## Develop

```shell
npm test
copilot --plugin-dir . plugin list
```

## License

GNU General Public License v3.0, matching `git-stash2d`. See [LICENSE](LICENSE).
