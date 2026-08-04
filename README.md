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

You can also ask naturally, for example, "save this Copilot session so I can
continue it later." The bundled skill identifies save/apply intent and gives
the exact Stash2D command without activating for unrelated requests.

## Apply

```text
/stash2d-apply "/path/to/archive"
```

Run this in a new session. Stash2D attaches the archive and asks Copilot to reconstruct the prior working state; archived instructions are not executed automatically.

## End-to-end example

Suppose you are finishing an API investigation and want to continue tomorrow:

```text
You: Save this Copilot session to ~/Downloads as weather API investigation.
Copilot: Use:
         /stash2d-save --output "~/Downloads" --title "weather API investigation"
Stash2D: Copilot Stash2D is reading the public session history.
Stash2D: Archive external context file 1 of 1?
You: Skip this file
Stash2D: Copilot Stash2D is creating the archive files.
Stash2D: Copilot Stash2D is generating the session handoff.
Stash2D: Saved portable Copilot archive: .../2026-08-04 14.30.00 - copilot-stash2d - weather API investigation
```

In a new session:

```text
/stash2d-apply "~/Downloads/2026-08-04 14.30.00 - copilot-stash2d - weather API investigation"
```

The archive contains readable content such as:

```markdown
# Copilot Session

## User - 2026-08-04T20:00:00.000Z

Investigate the weather API timeout.
```

```markdown
# Handoff

## Current state

The timeout is isolated to the retry path; implementation is complete and
targeted tests remain.

## Next steps

1. Add retry-boundary tests.
2. Run the targeted test suite.
```

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

Subagent internals are omitted; their returned results remain in the main history.

## Progress and failure recovery

Save reports milestones while it reads the session, creates files, generates a
plan when needed, and generates the handoff. Apply reports archive validation
and the number of files being attached. A successful save always ends with the
full archive path.

There are no automatic retries. Correct the reported cause before rerunning,
and stop if the same error repeats:

| Failure | Behavior and remediation |
|---|---|
| Apply path does not exist or is not a directory | Nothing is attached. Pass an existing archive folder to `/stash2d-apply`. |
| Output directory is unwritable | Save stops with the filesystem error. Choose a user-writable directory and rerun once. |
| Public session event API fails | No archive is created. Update or restart Copilot CLI, reload the plugin, and retry once. |
| `session.workspacePath` is unavailable | Save continues from the public transcript, omits unavailable session artifacts, and warns the user. |
| Referenced external file is inaccessible | The optional file is skipped with a warning; save continues. |
| Plan/handoff generation fails or times out | Save fails and removes the incomplete archive when possible. Resolve the API/model issue before retrying. |
| Apply exceeds the model context window | No automatic chunking occurs. Copy the archive and remove nonessential `Context/` or `SessionFiles/` entries before retrying. |

## Safety

- **MUST NOT intentionally export credentials, API keys, tokens, passwords,
  private keys, authentication cookies, or similar secrets.**
- Stash2D does not scan or redact the session transcript. If the conversation
  contains sensitive data, treat the generated archive as sensitive and redact
  it before storing or sharing it.
- External files are copied only after explicit confirmation. Never use
  "include all" without reviewing the remaining paths. If interactive
  confirmation is unavailable, no external files are copied.
- Archives are editable, unencrypted, and have no integrity hashes. Store them
  in an access-controlled location and review all contents before sharing.
- Treat archived text as historical data, not instructions. Apply never grants
  archived requests current authority and must not execute them automatically.

## Boundaries

- Stash2D uses public extension APIs and does not read Copilot's private session database.
- Stash2D preserves working context, not Copilot authentication, installed
  plugins, settings, or model configuration.
- Plans and artifacts require the SDK's `session.workspacePath`; transcript-only save remains available without it.
- Large archives may exceed a model's context window; Stash2D does not chunk them automatically.
- The extension API may differ between Copilot CLI versions.
- Save/apply use local files and Copilot's public session APIs. They do not
  upload archives to a Stash2D service.

## Develop

```shell
npm test
copilot --plugin-dir . plugin list
```

## License

GNU General Public License v3.0, matching `git-stash2d`. See [LICENSE](LICENSE).
