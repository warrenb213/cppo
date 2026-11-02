# Changelog

## 1.20.0 — 2026-11-02

### Added

- **Google AI (Antigravity) as a provider.** *Add a Provider → Google AI* adds the models your Google AI plan includes as workers, through Antigravity's own CLI (`agy`) — the plan is only ever used by its client, CPPO never reads its sign-in, and nothing is sent to Google by CPPO itself. Verified live on an AI Ultra 5x account: `agy models` gives Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5 and Sonnet 5.5, GPT-OSS 120B (effort variants collapse into one worker per model, with the efforts it takes). Consultations, edit-only agent tasks, 2D art, plan usage in the AI Usage panel (5-hour and weekly, per model group; a Gemini worker is only passed over for the Gemini group's pressure), roles (Argon as a strongest model, Flash as quick), the Codex-style own-versus-shared sign-in choice with reuse of orphaned sign-ins, the duplicate-service warning and the shared-sign-in notice.
- **Per-provider sign-in that is real.** Each Google AI provider gets a private `HOME`; agy keeps its token as a file there when it has no D-Bus session, so two providers can't share an account by accident. (`AGY_ACCOUNT` is ignored by agy when wrong — it can't pin an account — so it isn't used.)

- **`agy` and its installer's needs are detected, and installing is offered wherever it's missing.** Adding Google AI, *Test connection*, a Google AI provider whose `agy` has gone missing (once per window session) and the orchestration panel all check for `agy` (login-shell PATH, then `~/.local/bin`); the installer's own needs — 64-bit CPU, bash, curl or wget, tar, sha512sum — are checked first and named when absent. The install command is shown in a terminal for you to run, never run for you, and a *Check again* button re-detects it without a reload (a miss is no longer cached).

### Fixed

- **README: the Marketplace badges showed "retired".** shields.io no longer serves Visual Studio Marketplace badges, so the page (and the Marketplace listing, which renders the README) showed retired placeholders. They're replaced by a plain install link, and every CPPO Marketplace link now uses `…?itemName=BeboutItSolutions.cppo&ssr=false#overview`.

### Decisions worth knowing

- **Agent tasks on Google AI are edit-only, on purpose.** agy lets a model retry a refused shell command outside its sandbox (`BypassSandbox`); with commands allowed, a test run did exactly that and wrote a file outside the workspace, and no setting (`enableTerminalSandbox`, `allowNonWorkspaceAccess`, a narrower allow rule) closed it. Commands, `read_url` and `execute_url` are therefore denied in every Google run; writes outside the worktree are refused. Google workers are skipped for `test-and-fix` and tell the lead which checks to run.
- **No silent half-done work.** A refused action leaves agy at exit 0 with `SUCCESS`; CPPO reads `denied_actions`, lists them in the report, and fails a run that changed nothing. A signed-out `agy -p` hangs in a browser sign-in instead of failing, so every run is preceded by a free `agy models` check.
- **2D art** comes back as 1024×1024 JPEGs (painted-on checkerboard, no real transparency) from outside the worktree; CPPO copies them into `assets/generated/`. Codex ranks ahead for art.

## 1.19.0 — 2026-11-02

### Added

- **The lead keeps going while agent tasks run.** On one host, 248 of 381 `start_task` calls were followed by a turn that simply ended — nothing wakes the lead when a task finishes, so the user had to type "status" or "proceed". While agent workers are enabled, CPPO now registers a Claude Code **Stop hook** (`mcp_tool` type, calling a new `stop_check` tool on the workers server) in the window's `settings.json`. When the lead tries to stop with tasks *its own session* started still running — or finished but never read — the hook blocks the stop and tells it to `wait_task`; once everything is done and read, it lets go. Safeguards: it reads the session's transcript to know which tasks are its own, ignores tasks the window no longer knows (after a reload), doesn't fire on an Esc interrupt, stops blocking after 60 in a row, and removes itself (leaving your other hooks alone) when no agent worker is enabled. Verified live against Claude Code 2.1.303: without the hook the lead started a task and said "FINISHED" at 11 s with the task still running; with it the lead was blocked once, waited, and finished at 35 s with the real result.
- Tighter wording the lead sees: `start_task`, `wait_task` ("still running — call wait_task again now") and the server instructions all say not to end the turn while tasks run.

### Fixed

- **New files Codex created through the shell were dropped from a task's result.** Codex writes most files with heredocs and redirects, which CPPO classed as "side effects of commands" and left out — a task's whole new module vanished from its diff. New files from Codex runs are now kept unless they look like caches or build output.

## 1.18.2 — 2026-10-22

### Fixed

- **A stale uninstall script wiped a host's saved state.** VS Code runs an uninstalled extension's script at the next *server* start, not at Uninstall. On one host, three copies uninstalled days earlier (`DercasDrol.claude-parallel-accounts` 1.15.3, `warrenb213.cppo` 1.16.2, `beboutit503.cppo` 1.17.1) had their scripts run together after a reboot; the 1.15.3 one only knew two extension IDs, found no other copy beside `BeboutItSolutions.cppo`, and ran its full cleanup — deleting the state file (every provider record, roles, the host ID that names stored keys), the account stores and the window copies (conversation history was moved to `~/.claude` first and survived; one account's login was handed back, the other's lost). Now:
  - **A usage lease** (`~/.config/cppo/in-use`, refreshed hourly while CPPO runs, under any extension ID): the uninstall script touches nothing while the lease is under 30 days old — whatever other copies it does or doesn't recognise. A deliberate uninstall therefore leaves CPPO's data in place until CPPO has been unused for 30 days (the README says how to clean up sooner).
  - **A state backup** (`~/.config/cppo/state.backup.json`: providers, roles, accounts, host ID; no secrets), outside everything older scripts remove. If the main state file is missing, corrupt or unreadable, CPPO restores from the backup (self-healing on the next write) and tells you. The one-time migration no longer runs when a backup exists, and a missing backup is created at start.
  - **Reuse of orphaned Codex sign-ins:** adding a Codex provider with its own sign-in offers any sign-in folder on the host that no provider points at any more, showing the ChatGPT account it belongs to, before asking you to sign in again.
- README: the uninstall timing, the lease and its 30-day consequence, the `~/.config/cppo` files, and why uninstalled-but-pending old copies are dangerous.

## 1.18.1 — 2026-10-21

### Changed

- **README: CPPO is on the VS Code Marketplace** ([`BeboutItSolutions.cppo`](https://marketplace.visualstudio.com/items?itemName=BeboutItSolutions.cppo)), so installing is no longer manual-only: the Install section leads with the Extensions view / `code --install-extension BeboutItSolutions.cppo`, with the `.vsix` from GitHub Releases as the alternative (offline hosts, builds of your own); updates come through VS Code; Marketplace and install badges; the release process and the platform note (one universal package, offered everywhere, inert off Linux) say so. The Marketplace shows the README packaged in the extension, hence this release.

## 1.18.0 — 2026-10-21

### Changed

- **Publisher `BeboutItSolutions`:** CPPO's extension ID is now `BeboutItSolutions.cppo` (it was `beboutit503.cppo`). The generation mark moves to 4, so an installed `beboutit503.cppo` 1.17.x steps aside on its own and — its uninstaller keeping shared data — can be uninstalled normally. Accounts, providers, roles and history carry over; provider keys are recovered from window settings or asked for once (VS Code keeps secrets per extension).

## 1.17.1 — 2026-10-21

### Fixed

- **A Codex provider rode on whichever ChatGPT account Codex was signed in as on the host.** Providers are saved per Claude account, but Codex keeps one sign-in per Linux user (`~/.codex`), so a work account's new Codex provider silently used the personal ChatGPT sign-in — no sign-in prompt, work content going to a personal plan. Now:
  - a new ChatGPT-plan provider gets **a sign-in of its own** (a Codex home per provider, `~/.claude-windows/codex/<id>`) and is prompted to sign in (`codex login`, `--device-auth` in remote windows); using the host's `~/.codex` sign-in is an explicit choice that names the account Codex is signed in as and who else uses it;
  - providers from earlier versions keep working as before, but if Claude accounts of more than one email share the host sign-in, CPPO says so once and offers each its own (*Give it its own sign-in* / *Keep sharing*), never switching anything by itself; *Edit or Remove a Provider* switches either way;
  - removing a provider deletes its own sign-in.
- **The terms warning fired too widely** — a work account's new OpenAI provider warned about a *personal* account's. It now counts only providers in the same Claude account, treats two Codex providers on one host sign-in as the one ChatGPT account they are, and says "account" for a ChatGPT sign-in and "key" for keys.

### Changed

- README: a notice that CPPO is a personal project and that personal and work accounts, keys and code shouldn't be mixed on one machine; a matching note under *Terms of service*.

## 1.17.0 — 2026-10-20

### Changed

- **Publisher `beboutit503`:** CPPO's extension ID is now `beboutit503.cppo`, the publisher it will have on the Marketplace. Accounts, providers, roles and history carry over; provider keys are recovered from window settings or asked for once (VS Code keeps secrets per extension).
- **No more bridges after this one.** Every copy now carries a mark in its `package.json` — `"cppo": { "generation": N }` (3 here). The newest generation runs and older marked copies step aside on their own; an uninstaller keeps the shared data while any other marked copy (or a known earlier ID) is installed. CPPO stays idle beside an older copy without the mark, whose uninstaller would delete its data, and says which bridge to install.
- **No bridge releases.** CPPO has no other users yet, so none were published: remove an older copy by deleting its folder under the extensions directory rather than uninstalling it (older uninstallers delete the shared data). `scripts/package-variant.py` can still build one.
- README: *Moving from an earlier copy* covers both earlier IDs; it no longer says CPPO will never be on the Marketplace.

## 1.16.1 — 2026-10-20

### Changed

- **README:** a small PayPal QR code at the very top, next to the *Donate* badge — on GitHub and in VS Code's extension details tab (which shows the README packaged in the extension, hence this release).

## 1.16.0 — 2026-10-20

**Claude Parallel Accounts is now CPPO — Claude Parallel Profile Orchestration**: a separate project with its own extension ID (`warrenb213.cppo`), repository ([warrenb213/cppo](https://github.com/warrenb213/cppo)) and packages (`cppo-<version>.vsix`). Accounts, providers, roles and history carry over.

### Changed

- **New identity.** Extension `warrenb213.cppo`, display name *CPPO — Claude Parallel Profile Orchestration*; commands `cppo.*` under *CPPO:* in the Command Palette; log channel, status bar card and panel titled CPPO; the workers MCP server is `cppo` (tools `mcp__cppo__…`). No Marketplace listing, so nothing can update over it.
- **Moving over from the old extension.** CPPO stays idle while a Claude Parallel Accounts older than 1.15.3 is installed (its uninstaller would delete the data CPPO uses) and says how to proceed; with 1.15.3 installed it runs and asks for the old one to be uninstalled. It recovers provider keys still held in this account's window settings (gateways, Anthropic API keys), asks once for the rest, recognises each window's provider from its settings, keeps a window's provider until its key is entered again, and removes the old workers server's entry from each window's Claude Code config.
- **Uninstalling CPPO** leaves the data alone while any copy of either name is installed.
- README, license and links updated for CPPO; credit to the original project.
- **Support CPPO**: a PayPal link — the repository's *Sponsor* button (`.github/FUNDING.yml`), the extension page's *Sponsor* link (`sponsor` in `package.json`), and the README, with a QR code to scan.
- **README diagrams render everywhere**: they're PNG images now, rendered from Mermaid sources in `docs/diagrams/` (`scripts/render-diagrams.sh`) — VS Code's extension page doesn't render Mermaid. The architecture diagram is redrawn around the window, your home directory and the services you use.

## 1.15.3 — 2026-10-20

The last release under the name Claude Parallel Accounts (`DercasDrol.claude-parallel-accounts`): the bridge to **CPPO** (`warrenb213.cppo`), its new name.

### Changed

- **Steps aside for CPPO.** With CPPO installed, this extension does nothing — no account switching, no commands, no files touched — and says so in the status bar, so the two never claim the same window.
- **Its uninstaller leaves CPPO's data alone.** Uninstalling it while CPPO (or any other copy of either name) is installed removes nothing: your accounts, providers, roles and history are CPPO's now. Earlier versions don't know CPPO and would delete them — update to this one before uninstalling.

## 1.15.2 — 2026-10-20

### Added

- **Terms warnings.** Adding a provider of a service this host already has — for this account or another (a second Z.ai key, a second Codex sign-in or OpenAI key, a second Anthropic API key, a second custom gateway on the same host name) — asks first, saying that more than one account or key with one service, used to get around its usage limits, may break its terms; *Add it anyway* continues. Saving a second Claude account adds the same note to the sign-in notice. The extension doesn't check or work around anyone's terms.

### Changed

- **Wording.** The README and the lead's tool descriptions no longer suggest keeping a second account for when one hits its limits; accounts are for separate purposes (personal, work, organizations), and roles balance work across different services. New *Terms of service* section in the README.

## 1.15.1 — 2026-10-20

### Changed

- **The orchestration panel works from every model, not just enabled workers.** It lists each model your providers offer with what it can do — answers, agent tasks, image generation, image input — from the providers themselves where they say (Codex's model list and its image-generation capability, a gateway's model list). Any model that can do a role's kind of work can be added to it; one not enabled yet is marked *enabled on save*, and saving enables what the roles use — as a worker, and for agent tasks where needed — after one confirmation. *Suggest from all models* builds chains from everything available.
- **The Anthropic plan's usage, always.** Claude Code caches the usage report `/usage` shows in its config (`cachedUsageUtilization`); the panel, `provider_usage` and the role thresholds now read it from this account's windows — the 5-hour, weekly and per-model weekly windows, with the plan tier (e.g. *Max 20x*) and when Claude Code fetched it. A file read: no token, no request. Before, it only showed up after a worker call on the login.
- **README:** what each provider can do (chat window, answers, agent tasks, 2D art, plan usage) in one table, a worked multi-subscription setup with its flow, Codex and orchestration in the architecture diagram, and install from GitHub Releases.
- **Suggested chains spread across providers**: the strongest current model first (newer generations win ties), the first fallback on another provider — a used-up plan fails every model on it — and at most two models of one provider per chain.

## 1.15.0 — 2026-10-20

### Added

- **OpenAI Codex as a provider for workers and agent tasks.** *Add a Provider → OpenAI Codex* adds GPT models (whatever Codex lists for the account — `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`…) as workers. Everything runs through the Codex CLI itself — the OpenAI extension's bundled binary, or `codex` on PATH:
  - **Sign-in:** a ChatGPT plan through Codex's own sign-in (default; the extension never touches its tokens, and offers `codex login` in a terminal — `--device-auth` in remote windows), or an OpenAI API key, kept in secret storage and passed to each run as `CODEX_API_KEY` with a Codex home of its own.
  - **Consultations** (`delegate`): `codex exec`, read-only, in an empty folder, with the shell and other tools off and the user's Codex config and rules not loaded.
  - **Agent tasks**: Codex itself in the worktree (`--approve-for-me`: workspace-write sandbox with automatic approval review, no network for commands), browser, desktop and plugins off, nothing kept on disk; it consults other workers through the workers MCP server (verified: Codex completes the MCP handshake with it). Transcripts show its commands, edits and consultations; limits count Codex steps.
  - **Usage**: the ChatGPT plan's Codex windows (5-hour, weekly, per-model limits) in `provider_usage`, read from `codex app-server` (`account/rateLimits/read`) without sending a message.
  - **Test connection** (who Codex is signed in as, or the API key against OpenAI's model list) and *Refresh model list* (`model/list`).
  - **GPT in chat windows, on an OpenAI API key.** *Chat-window models* picks which GPT models appear in Claude Code's model picker and which is the default; the window then bills to the key through the local LiteLLM proxy (OpenAI isn't Anthropic-compatible), as non-Claude gateway models do. Claude Code's opus/sonnet/haiku slots get GPT models and only the enabled ones are allowed. Verified up to OpenAI: a Claude Code request through the proxy reached `api.openai.com` and came back in Claude Code's format. A ChatGPT plan stays workers-only — the extension doesn't use it outside Codex (LiteLLM's `chatgpt/` provider would, by presenting itself as the Codex CLI).

- **Orchestration: roles and fallbacks.** The lead can ask by role — `delegate(role: "review")`, `start_task(role: "implement")` — and the extension picks the model from a chain the user set, the same way every time. Roles by category: *Answers* (quick, second-opinion, review, hard-reasoning), *Build* (implement, test-and-fix), *Art* (2d-art via Codex image generation, vector-art). Each chain entry has an effort (Claude Code `--effort`, Codex reasoning effort clamped to what the model takes, a thinking budget on Messages-API workers). Entries past 95% of a 5-hour or 90% of a weekly window (configurable) are passed over; failures a next provider may not share (rate limit, used-up plan, sign-in, outage) fall back to the next entry. Answers and tasks report who served them and what was passed over; `list_roles` shows the lead the same. Until saved, a template builds the chains from the configured workers, subscriptions first.
- **Orchestration panel** (*Claude Accounts: Orchestration*, and in the account's hover): the configured account, providers, workers and plan usage; each role's chain to reorder, extend or switch off, with effort; the thresholds; and a live preview of who would serve each role now.

### Fixed

- The agent-task consent still said "80 turns, 30 minutes"; it now gives the current limits.

## 1.14.2 — 2026-10-19

### Fixed

- **Uninstalling could delete a `~/.claude-<name>` folder you made yourself.** The extension adopts any signed-in `~/.claude-<name>` folder it finds as an account, and listed it with the stores it created; uninstall then deleted it after moving its history into `~/.claude` — along with its settings, plugins and anything else in it. Stores the extension creates now carry a marker (`.claude-parallel-accounts`), and uninstall deletes only those. An adopted folder keeps its login and files; only the history links the extension put in it are removed. Stores saved by earlier versions are sorted once on upgrade: one named after its account's email, as the extension names them, counts as created; anything else is kept.
- The history merge's backup folder (`~/.claude-shared/.merge-backup`) is now created owner-only, like everything else.
- Two stale code comments (the status bar's click action, and how non-Linux installs reach the inert mode).

### Changed

- **README rewritten** for this fork: an architecture diagram and workflow diagrams (window start-up, sign-in, forget, shared history, providers, workers, `delegate`, agent tasks and their states, uninstall), install from `.vsix`, a commands table, and corrections where it had drifted from the code — every network request listed in *Privacy*, the real bundle size, sign-out handling, what uninstall removes.

## 1.14.1 — 2026-10-19

### Fixed

- **Agent tasks were cut off after 30 minutes, and their work was trapped.** Two GLM runs building a C++ project were stopped mid-build at exactly 30 minutes with ~900 and ~1,900 lines written; as "failed" tasks, neither could be applied or built on. Now:
  - each run gets 2 hours and 300 turns by default; the lead can set `minutes` (5–480) and `max_turns` (10–1000) per task, and a run with no output for 20 minutes is stopped as stuck;
  - the worker is told its limits, so it can stop in time to report;
  - a run stopped at a limit or cancelled keeps its collected changes: `apply_task_changes` takes them, and `start_task` with `after` continues from them — the follow-up is told the run was stopped and gets its last message. `wait_task` says so, with that last message;
  - cancelling no longer reports the task ended before its changes were collected.
  - In the hover, a stopped task with changes shows them (files changed, applied or not) instead of a bare error.

## 1.14.0 — 2026-10-19

### Added

- **Worker transcripts from the account hover.** Each agent task's worker name opens that task's transcript; each worker under *Workers* shows how many tasks and consultations it has in this window and lists them to open. A task's transcript is its run made readable — the worker's messages, each tool call with its command or edit, results and thinking collapsed, the report and changes — and follows along while the task runs; a consultation's shows the question, context and answer. Also *Claude Accounts: Show Worker Transcripts*, and *Open transcript* in *Show Agent Tasks*.
- **Agent tasks can take gitignored files they need.** `start_task` takes `include`: files or folders (repo-relative) copied into the worker's copy even when gitignored, within their own budget (5 MB a file, 100 MB and 2,000 files in all; a folder over it is refused whole). Files the task or context names by absolute path inside the repo are copied in too, and those paths are rewritten to the worker's copy — a task that pointed GLM at a plan in a 162 GB `.temp` got a worker that couldn't see it.

### Fixed

- **A GLM worker couldn't write any file.** Agent tasks and login workers ran the `claude` on PATH. On one host that was an npm global Claude Code 2.1.81 beside the extension's 2.1.301, and 2.1.81 started the headless gateway run in "default" permission mode despite `--permission-mode auto` — every edit and redirect was denied, and the worker reported it was blocked after 30 turns. They now run the Claude Code extension's own binary (the version the chats use), falling back to PATH only where that extension isn't installed, and a run that starts in any mode but auto is stopped at once with the reason. Reproduced on that host: 2.1.81 denied the write, 2.1.301 made it.

## 1.13.2 — 2026-10-19

### Changed

- **Agent tasks and workers live on the account's status bar item.** Its hover card now lists the window's workers and recent agent tasks (worker, turns and current action while running, files changed and whether applied when done, or why it failed), with *Agent tasks* and *Usage* links beside *Switch account* and *Switch provider*. While tasks are active the item's text shows a count (`· ⟳ 2`). The separate agent-task status bar item is gone.

## 1.13.1 — 2026-10-19

### Fixed

- **Agent tasks could copy an entire project's scratch data.** The task snapshot ("HEAD + uncommitted changes, untracked files included") ran `git add -A`. In a project with 162 GB of untracked scratch data in a folder that wasn't gitignored (`.temp`), three tasks started at once each began hashing all of it into the repository's object store — 8.3 GB written before they were stopped. Now:
  - untracked files are taken within a budget — 5 MB a file, 100 MB and 2,000 files in all — by top-level folder, smallest first; a folder that doesn't fit is left out whole;
  - Git LFS files are never added (modified ones keep their committed version) and worktrees keep them as pointers (`GIT_LFS_SKIP_SMUDGE`), so their content is never copied;
  - a repository whose tracked files exceed 5 GB is refused; snapshots run one at a time per repository, each git step capped at 2 minutes;
  - what was left out is told to the worker and to the lead, with a hint to gitignore scratch data.
  On the affected repository the snapshot now takes 16 s and writes a few KB.

## 1.13.0 — 2026-10-19

### Added

- **Open sessions see worker changes live.** The workers server now keeps the notification stream Claude Code opens and sends `tools/list_changed` when workers or agent tasks are switched on or off; open sessions re-read their tools instead of keeping the list they started with. Verified in an interactive session: a worker enabled mid-session was used from that same session.
- **Agent tasks can build and test.** Gitignored dependency folders at the top of the repo (`node_modules`, `.venv`, `venv`, `vendor`, `.bundle`, …) are linked into the task's worktree, so the worker can run builds and tests; the links are removed before its changes are collected and are never part of a diff. Verified with a GLM-5.3 run that needed a package from a linked `node_modules`.

### Changed

- **The pre-1.8 shared provider copy is removed.** Once a host has adopted its providers, the old client-wide provider list and its key entries (e.g. an old Poe key) are deleted from VS Code's storage. A host still on 1.7 or earlier then starts with no providers.

## 1.12.2 — 2026-10-19

### Fixed

- The proxy's version check treated an unparsable *recorded* version inconsistently: `olderThan('1', '2.x')` returned true, so a malformed state file could make a window yield to a "newer" proxy. An unparsable recorded version now counts as the oldest. (Written by a GLM-5.3 agent task, reviewed in-task by Claude Sonnet on the login worker, and applied after the lead's review — the first change made through the extension's own agent tasks.)

## 1.12.1 — 2026-10-19

### Fixed

Found validating workers from a real Claude Code session:

- **Slow consults failed with "The operation timed out."** Claude Code gives an MCP call 60 s unless the server entry sets `timeout`, and drops an HTTP MCP call that stays silent for 5 minutes. A consult on the Anthropic login that hit a network stall took 143 s — it finished, but the lead had already given up. The workers server is now registered with `timeout: 295000`; worker calls end within 270 s and `wait_task` waits at most 240 s per call (call it again for longer tasks). A 75-second consult was verified through Claude Code.
- **Workers enabled after a session started couldn't be named.** `delegate` and `start_task` listed the workers as an enum, which a running session keeps from its start. The schemas no longer fix the list; the server checks the name and an unknown one is answered with the workers enabled now.
- **GLM workers returned an empty answer.** GLM thinks by default and its thinking counts against `max_tokens` — with a 400-token cap, GLM-5.3-Flash spent all of it thinking. Worker calls now add 8,192 tokens of room for reasoning on top of the answer cap, and a reply that still has no text is asked again with thinking off.

## 1.12.0 — 2026-10-19

### Added

- **Chained agent tasks.** `start_task(..., after: <task_id>)` starts from another task's result (waiting for it if it's still running), so pipelines can be queued at once. Applying a chained task also applies the earlier, unapplied tasks of its chain.
- **Workers can consult.** Agent runs get `delegate`, `list_workers` and `provider_usage` (answers only) through a token limited to those tools — they can't start tasks.
- **Claude on the account's own login as a worker.** *Edit or Remove a Provider → Anthropic login (this account)* enables haiku / sonnet / opus on the subscription as workers, for the lead and for agents (e.g. GLM asking Claude for a second opinion). Each call is Claude Code itself, headless, on the account's own directory, with no tools, no MCP servers and no saved session; the extension never handles the subscription's token.
- **Usage awareness.** `provider_usage` and *Claude Accounts: Show Provider Usage*: the Anthropic login's 5-hour and weekly windows (from Claude Code's rate-limit reports), Z.ai's credit windows (from its unofficial quota monitor), and this window's calls, tasks and tokens per worker.
- Verified on real providers: a GLM-5.3 task chained after another built on its result, consulted Claude Haiku on the user's Team subscription mid-task (4 s) and quoted it; the chain applied as one; both plans' usage reported.

## 1.11.0 — 2026-10-19

### Added

- **Agent tasks: workers that do real work.** A second opt-in under *Workers* lets chosen worker models run agent tasks. The lead gets `start_task`, `wait_task`, `cancel_task` and `apply_task_changes`: Claude Code runs headless on the worker's model, in auto mode, in a scratch git worktree made from the repo (HEAD + uncommitted changes, untracked files included, the user's index untouched), with a fresh config holding no login, plugins or MCP servers and the provider key only in its environment. It returns the worker's report and a diff; the lead reviews it and may apply it to the working tree (never staged).
  - Command side effects (build output, caches, logs) are reported but left out of the diff; changes to existing files and files the worker wrote with its file tools are included.
  - Limits: 2 tasks at a time, 80 turns, 30 minutes. Status bar entry and *Claude Accounts: Show Agent Tasks* (log, patch, cancel). Patches and logs kept 7 days; worktrees removed when a task ends, or when its window closes.
  - Verified on a Z.ai Coding Plan: GLM-5.3 fixed a bug, wrote a new test file and ran the suite under auto mode (31 s, 17 turns); the applied diff held exactly the two intended files, the user's uncommitted edits and untracked files were kept, and nothing was staged.

## 1.10.0 — 2026-10-19

### Added

- **Workers: let the window's AI consult other models.** *Edit or Remove a Provider → Workers* enables some of a provider's models (e.g. GLM-5.3 and GLM-5.3-Flash on Z.ai, Claude models with an Anthropic API key) as workers. New Claude Code sessions in that account's windows get `list_workers` and `delegate`: the lead sends a focused task plus the material it chooses, the worker answers, and the lead checks the answer. Workers only answer — no file access, no commands.
  - Served by a small MCP server inside the extension (127.0.0.1, random token); keys are read from secret storage per call and never written to a file. The window's own provider is unchanged, so a window on the Anthropic login keeps it.
  - Opt-in per provider and model, off by default, with a confirmation of what leaves the machine. Limits: 120,000 characters out and 8,192 tokens back per call, 100 calls per window session. Each call is logged (worker, time, tokens — not content).
  - Verified end to end: Claude Code called `delegate`, GLM-5.3-Flash on a Z.ai Coding Plan answered in ~3 s.
- Also verified on Z.ai: auto mode's own safety checks run on GLM there, approving safe actions and blocking unsafe ones (e.g. piping a download into `sh`). Each check sends roughly 35K tokens of classifier instructions.

## 1.9.1 — 2026-10-19

### Added

- **Connection test.** Adding a provider now sends it one tiny request (a single output token) exactly as Claude Code would — same endpoint, key header and model (the cheapest configured one) — and shows the provider's own answer if it fails, with a plain hint: key rejected, endpoint or model not found, or rate-limited / plan or balance not covering it. Previously such a failure only showed in the first chat as an apparent hang, because Claude Code retries a 429 up to 11 times. *Edit or Remove a Provider → Test connection* runs it any time. A provider whose test failed can still be used, with a warning.

### Fixed

- Adding a custom gateway that has no readable model list failed with an error (a regression in 1.9.0); it again says the list couldn't be read and points to model aliases.

## 1.9.0 — 2026-10-18

### Added

- **Prebaked providers.** *Add a Provider* now lists, besides an Anthropic API key: **Poe** and **Z.ai GLM Coding Plan**, each set up from just a name and a key, and **Custom** for any other Anthropic-compatible endpoint (the previous flow).
  - **Z.ai** follows Z.ai's documented Claude Code setup: its Anthropic-compatible endpoint, Bearer key, GLM in the opus/sonnet/haiku slots (`glm-5.3[1m]`, `glm-5.3-flash[1m]` for haiku) with the 1M context window, matching auto-compaction and a long request timeout. GLM is served natively — no proxy. The slots can be changed under *Model aliases*.
  - **Poe** keeps reading its model list; its non-Claude models stay opt-in through the local proxy.
  - A preset's endpoint and key header are fixed; a custom gateway can still change both.

### Fixed

- Adding a gateway whose model list couldn't be read now says so, instead of failing on the missing list.

## 1.8.5 — 2026-10-17

### Fixed

- **"API Error: Part of the response never arrived" with non-Claude models on Poe.** Poe's stream marks the reply finished (`finish_reason: "tool_calls"`) right after the first tool call, then streams the next ones. LiteLLM believed the early finish and dropped the later tool calls' block starts — names and ids included — so Claude Code discarded the rest of the reply whenever the model called several tools at once. The proxy's hook now holds such an early finish back until the reply really ends; standard streams pass through unchanged.

## 1.8.4 — 2026-10-17

### Fixed

- **A window reloading mid-start could leave the proxy wrong for three minutes.** The proxy's start lock was only taken over once it was three minutes old. A window reloaded while starting the proxy (as after an update: the old code started one without the schema hook in its last seconds) left the lock behind, and the updated windows waited it out while every request failed — the chat looked hung. The lock now records its owner's process, and a lock whose owner is gone is taken over at once; the three-minute rule remains only as a fallback.

## 1.8.3 — 2026-10-17

### Fixed

- **"claude-sonnet-4-6 is temporarily unavailable (connection failed)" in auto mode, and dropped replies.** Every window on a host shares the provider's local proxy and brings it in line whenever it gains focus. Two windows running different extension versions (one not reloaded since an update) each rebuilt the proxy their own way, taking turns restarting it — five restarts in three minutes were seen — and every request in flight, auto mode's classifier checks included, failed with "connection failed". The proxy now records which version started it, and an older version reuses a newer one's proxy instead of rebuilding it (port and key are unchanged either way). A running proxy that misses one 2-second health check (busy, not dead) also gets three chances before it is restarted. Windows still running ≤ 1.8.2 code need one reload to stop taking part.

## 1.8.2 — 2026-10-17

### Changed

- **No more auto mode "this session isn't eligible" notice on gateways.** Auto mode now asks Anthropic's API to run its safety checks inside each request; a gateway such as Poe can't, so Claude Code fell back to its own classifier requests after holding the first checked action behind that notice. Gateway windows now set `CLAUDE_CODE_AUTO_MODE_SERVER=0`, which gives the same fallback without the notice — every action is still checked, and the classifier requests are billed by the gateway as before. Not set for the Anthropic login or an Anthropic API key, and removed when a window switches back.

## 1.8.1 — 2026-10-17

### Fixed

- **Non-Claude models hung on every request.** Poe's GLM and Qwen reject one of Claude Code's own tool schemas (`ArtifactData` uses JSON Schema's `prefixItems`) with "Failed to parse tool definition"; LiteLLM answered 500 and Claude Code kept retrying, which looked like a hang. The proxy now loads a small pre-call hook (`litellm/schema_fix.py`, shipped with the extension) that rewrites such keywords for translated models only; Claude models pass through untouched. A new version of the hook restarts the proxy.
- **Switching back to Anthropic left a gateway-only default model behind.** Picking e.g. `glm-5.3` as the default in `/model` saves it in the window's settings; going back to the Anthropic login or an API key now removes it (Claude aliases and IDs stay), instead of sending `glm-5.3` to Anthropic.
- The window reload after switching provider no longer logs a "Canceled" error.

## 1.8.0 — 2026-10-17

### Changed

- **Providers belong to one account on one host.** Up to 1.7 a provider — its definition, key and enabled non-Claude models — was kept on the VS Code client and shared by every remote host and every Claude account. Now a window sees only the providers of the account it runs, on its own host. On first start each host adopts the old shared providers for the accounts that have a window using them there right now (by key, or by the local proxy's port), and for no one else; other accounts add their own. The account on a running proxy keeps the provider's id, so its windows don't change.

### Fixed

- The LiteLLM proxy's folder (`~/.claude-windows/litellm`) was taken for a window's working folder, and shared-history links were created inside it. Only real window folders are considered now, and the stray links are removed on start (links only — no history is touched).
- *Show proxy log* on a host where the proxy never ran explains that, instead of an error.

## 1.7.1 — 2026-10-17

### Fixed

- **"Non-Claude models: 0 available" after *Refresh model list*.** The refresh read the gateway's non-Claude models, then the edit menu saved its own copy of the provider over them, keeping only the Claude list.
- A provider whose model list was read by 1.5 or earlier (no non-Claude list at all) is now re-read on next use, instead of waiting up to a day.

## 1.7.0 — 2026-10-17

### Added

- **Anthropic API key as a provider.** *Add a Provider → Anthropic API key* takes a key from console.anthropic.com and sends the window's requests straight to Anthropic, billed per token — no base URL, model rewriting or proxy, and Claude Code's usual model lineup. The account's own login stays saved for switching back.
- **API keys are pre-approved for Claude Code.** Any provider that sets `ANTHROPIC_API_KEY` (an Anthropic key, or an `x-api-key` gateway) is recorded as approved in the window's `.claude.json`, so Claude Code's "Detected a custom API key" prompt — whose default answer, *No*, silently fell back to the login — no longer appears. An earlier *No* for the same key is undone.

### Changed

- **"Subscription" is now "Anthropic"** — the default for every window, labelled with what the account's login actually is: *Team plan · Acme*, *Max plan*, *Console API key*. It is read from the account's files, so it stays right while a provider overrides the login.

## 1.6.0 — 2026-10-17

### Added

- **Billing providers per window.** *Switch provider* points a window at the Anthropic subscription or at an Anthropic-compatible gateway (e.g. Poe) with its own base URL and key, without changing the account, its history or its settings. Keys live in VS Code's secret storage.
- **Provider model catalog.** The gateway's `/v1/models` list decides what Claude Code's model picker shows: exactly the Claude models it serves, each recognised as the model it is and sent under the gateway's name for it.
- **Non-Claude models through a local LiteLLM proxy** (opt-in, per provider). Qwen, GLM, DeepSeek… served in OpenAI's format are translated for Claude Code by a proxy on `127.0.0.1`; Claude models pass through untouched; models with a stated context window under 200K are not offered. LiteLLM is installed only on an explicit yes, every package pinned by SHA-256 (`--require-hashes`), and its remote-config downloads are disabled. The gateway key stays in the proxy's memory. Uninstalling stops the proxy.

### Fixed

- **Account state is kept per host**, not in client-shared global state — fixes a reload loop when one VS Code client connects to several remote hosts.
- The packaged extension no longer includes a stray `.claude/` directory.

## 1.2.5 — 2026-07-12

### Fixed

- **Shared-history links are created the moment a window's working directory is stocked**, not only at activation. Previously a `claude` process started right after a mid-session bind could write history into unlinked real directories — invisible to other accounts — and could not see conversations recorded before the bind, failing with "Session … not found" when forking/resuming (the root cause of that error on v1.2.0/1.2.1; the stray history was merged back into the shared store automatically, nothing was lost).

### Changed

- Sign-in/out wording in the README and in messages now leads with Claude Code's account-menu UI; slash commands are mentioned as the alternative.
- README documents the deliberate `*` activation trade-off: why winning the activation race against Claude Code requires it, and why the cost stays negligible (~25 KB bundle, zero dependencies, trivial activation path).
- README: the single-setting table replaced with plain text.

## 1.2.4 — 2026-07-12

### Changed

- **Linux-only platform gate.** The extension is built for the file-based credential layout Claude Code uses on Linux; elsewhere those assumptions break (macOS keeps credentials in the Keychain, native Windows is untested). Two layers now enforce this honestly:
  - the Marketplace release ships **Linux packages only** (x64/arm64/armhf + Alpine), so macOS / native Windows aren't offered the extension at all — WSL, Remote-SSH and dev containers install into the remote Linux side and keep working;
  - if a VSIX is side-loaded anywhere else, the extension activates into an **inert mode**: no files read or written, no accounts or settings touched (the uninstall hook is guarded the same way); the status bar and all commands explain the situation instead of failing cryptically.
- README: prominent platform-support note; deduplicated the header links (one Marketplace link instead of six) and replaced the retired shields.io marketplace badges with live CI/platform/license ones.

## 1.2.3 — 2026-07-12

The per-window architecture release: account isolation is now structural, not heuristic.

### Added

- **Per-window working directories.** Each window runs a private copy (`~/.claude-windows/<id>`) of its account's store, so a `/login` can only ever affect the window it happened in — no shared state, no focus guessing, no races.
- **Auto-save.** A signed-in account is saved the moment it's noticed; the separate "save" step is no longer required (the command remains for manual use).
- **Forceful forget.** Forgetting an account now deletes its OAuth token from every copy on the machine, interrupts live `claude` sessions running on it, and reloads any window that used it — with a confirmation up front and a "Switch account" offer after.
- **Logout handling.** `/logout` revokes the token server-side, so the account is removed from the list everywhere instead of lingering as a dead entry.
- **Terminals follow the window.** Integrated terminals get the window's account via VSCode's environment-variable collection.
- **Status bar hover card** with the extension's name, account details, actions, and quick links to Settings, the extension page, and the log (new *Show Log* command).
- **Reload circuit breaker.** All automatic window reloads correct their trigger state first and are capped at one per minute — a misbehaving edge degrades to a message with a manual button, never a reload loop.
- **Manifest self-restrictions:** disabled in virtual workspaces; limited (content never read, settings not overridable) in Restricted Mode.
- Signed-out windows offer one-click switching to a saved account (status bar click, notices, hover).

### Fixed

- Infinite reload loop after forgetting the account a window was running.
- Switching appearing to do nothing after an in-window `/login` (the window now fully reloads onto the new account; the old one stays in the list).
- Newly added accounts not appearing in other windows until restart (the registry now converges on the on-disk stores).
- A fresh login taking ~30 s to be saved (identity is read from disk instead of spawning the CLI).
- A failed working-copy stocking is no longer mistaken for a logout (which used to drop a perfectly good account).
- Uninstall now also reverts the nested per-window directories and removes their token copies.

## 1.1.5 — 2026-07-12

- Reliable per-window switching: activation-order fix (the extension now sets `CLAUDE_CONFIG_DIR` before Claude Code reads it), machine-wide setting overrides stripped, identity confirmed against the real token.

## 1.0.5 — 2026-07-12

- Rework into per-window parallel accounts with a shared conversation history store (`~/.claude-shared`) and clean uninstall.

## 1.0.0 — 2026-07-12

- Initial release: capture, switch and isolate Claude Code accounts per VSCode window.
