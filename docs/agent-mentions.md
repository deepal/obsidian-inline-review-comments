# Agent mentions

## Optional compatibility

AI Overview provides bridge version 2 through the `ai-overview:discover-v2` and
`ai-overview:bridge-changed-v2` workspace events. Updated Discussions
(`comment-block`) and Inline Review Comments (`inline-review-comment`) discover
v2 first and retain v1 support for older AI Overview versions. Older comment
plugins cannot launch direct work through the new AI Overview bridge. Plugins
remain independently installable; existing notes need no migration.

Only AI Overview adds an **Agent name tag** setting. Blank disables mentions.
Names start with a letter and contain up to 40 letters, numbers, underscores or
hyphens. A leading `@` and typed/pasted whitespace are removed. Matching is
case-insensitive and requires a complete tag. Quoted excerpts, blockquotes,
code, escaped mentions, email addresses and generated replies do not trigger.
Configured mentions receive a light accent highlight in comment bodies.

Without compatible, enabled AI Overview and a nonempty tag, neither comment
plugin adds integration controls, settings, animation or metadata to ordinary
comments. Mobile comment functionality remains available; execution is desktop
only. Highlighting and transient integration UI disappear when disconnected.

Forms trigger after their comment is committed. Direct Markdown editing waits
until the caret or selection leaves a completed comment, including editor blur.
Opening files, enabling plugins, changing tags, rerendering and synchronized
changes never execute old mentions. Editing an answered comment does not rerun
it: send a new mention reply for another request.

## Direct work and CLI permissions

The agent receives the initiating message, relevant thread, excerpt and current
note path. It follows applicable vault instructions, reads additional notes as
needed, performs the requested work directly, then returns only
`{ "reply": "Markdown response" }`. The originating comment plugin posts that
response in its normal thread format. AI Overview no longer requires proposed
replacement operations or applies note edits for new runs.

Comment runs inherit the configured CLI's normal configuration, permissions,
tools and integrations, including any access beyond the vault. Provider,
executable, model, reasoning, environment and compatible extra arguments are
reused. This launch mode is separate from overview generation; overview prompts
and their existing read-only defaults remain unchanged.

The plugin adds no full-access or auto-approval flags. Configured read-only access
remains read-only. Temporary approvals in another interactive CLI session do not
transfer to a new process. Unresolved approval requests fail with an actionable
error; configure the CLI outside Obsidian before retrying. Claude Code requires
`--permission-prompts none` support (2.1.259 or newer), which denies unresolved
prompts while retaining configured permission rules and modes. OpenCode uses its
normal agent and configuration without a restricted reader agent or injected
permission policy. Codex comment runs omit the overview's forced read-only
sandbox and retain the CLI's own configuration.

See the CLI documentation for [Codex unattended execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude Code headless permissions](https://code.claude.com/docs/en/headless) and
[OpenCode permissions](https://opencode.ai/docs/permissions/).

Output, prompt and session-resumption options are controlled by the plugin so it
can stream activity and capture the final response. Conflicting extra arguments
are rejected with the option name. User-configured permission and tool arguments
are retained; the plugin does not silently replace them with broader access.

Agents are instructed to preserve comment blocks, thread metadata and quoted
excerpts, and to report actual work, checks and failures. These instructions do
not create a filesystem sandbox. Direct edits and external effects take effect
immediately and are not rolled back on cancellation, timeout or failure.

## Editor safety and reply publication

Before execution, the comment host saves open Markdown editor buffers. Divergent
panes or stale buffers conflict rather than overwriting newer file contents.
After execution, publication reads current content inside `vault.process` and
inserts the reply next to the initiating comment, preserving surrounding agent
edits and conversation history. It never saves an old editor buffer over agent
changes. If an unsaved editor conflicts, the saved response is retained with an
actionable publication error. Reconcile the editor with the current file, then
retry publication.

Discussions reuses its comment IDs. Participating inline comments receive a
hidden `<!-- aio-comment:… -->` marker inside their existing `%%` block. Replies
carry a request marker to prevent duplicate publication. This metadata stays
hidden even after disconnecting. The initiating note follows renames. Changing
or deleting the initiating comment cancels active execution; missing destinations
at publication produce a retained-response error.

## Progress, persistence and retry

Jobs are serialized per vault instance and move through queued, running,
applying (posting the reply), completed, failed or cancelled states. The bridge
supports source attachment, submission, queries, subscriptions, retry and stop.
New direct jobs require a v2 host capable of preparing editor buffers.

Active work displays three animated typing dots above the reply composer. The
latest streamed activity appears beneath them in very small, muted text, using
the same events as AI callouts. Queue status is separate. The reply field and
send control are disabled and greyed out while queued or active; drafts survive
status updates. They unlock on completion, failure, cancellation or disconnect.
Screen readers receive accessible status text, and reduced-motion preferences
are respected. Transient progress is never written into notes.

AI Overview stores requests, final replies and outcomes in `mention-jobs.json`
in its plugin directory. This can contain comment content and can be synchronized
or backed up with the vault configuration. Duplicate prevention covers panes and
reloads in one installation; it is not a distributed lock across desktops.
The final result is persisted before publication. If publication fails, **Retry**
only posts that saved response and never reruns the agent.

Execution failures and interrupted runs require explicit retry. A new attempt
receives the previous failure and is told to inspect current state first. Actions
can still repeat: direct effects are not guaranteed to occur only once. Restarting
never automatically restarts unfinished work. Stopping a request or disabling a
participating plugin cancels execution; prior effects remain. Disabling AI
Overview also removes integration UI. Published replies remain ordinary content.

Existing history is preserved. Legacy results keep their recorded proposed
changes and per-change outcomes, including partial/uncertain application and
publication recovery. Unfinished legacy requests without a saved result switch
to direct execution only on explicit retry. With an older AI Overview and v1
bridge, its previous restricted execution behavior still applies.

## Verification

Automated tests cover optional discovery/fallback, mention matching, source
activity, identity, reply placement, stale buffers, renamed destinations,
serialization, interruption, durable publication retry and legacy recovery.
Provider subprocess fixtures exercise direct writes, inherited arguments,
streamed activity, permission denial and timeouts for all three providers.
Use an isolated Obsidian vault with synthetic notes and deterministic fixtures
for development checks before testing with a live model.
