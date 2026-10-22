# Agent mentions

## Optional compatibility

The interface is version 1. AI Overview provides it; Discussions (`comment-block`)
and Inline Review Comments (`inline-review-comment`) discover it through
`ai-overview:discover-v1` and reconnect on `ai-overview:bridge-changed-v1` workspace
events. Older versions without this interface operate independently. No minimum
Obsidian version change or migration of existing notes is required.

Only AI Overview has the **Agent name tag** setting. It defaults to blank. The
name starts with a letter and contains up to 40 letters, numbers, underscores or
hyphens. A leading `@` is removed. Mention matching ignores letter case and
requires a complete tag. Quoted excerpts, blockquotes, code, escaped mentions,
email addresses, and generated replies do not trigger runs.

Forms submit immediately after their comment is committed. Direct Markdown
editing waits until the caret or selection leaves a completed comment, including
blurring the editor. Startup, file-open, renderer updates, synchronized file
changes, and tag changes do not execute old mentions. Keep a completed comment
open until you have finished writing the request.

## Replies and note edits

The agent receives the initiating message, relevant thread, quoted excerpt and
current note path. It reads applicable vault instructions and other notes as
needed. The configured provider, executable, model, reasoning level, credentials
and compatible tuning settings are reused.

Comment runs return structured replies and proposed changes. AI Overview applies
requested changes automatically without an approval step. It can create Markdown
notes, including folders, or replace exact, unique text in existing notes. It
uses Obsidian vault APIs, preserves unrelated edits, and rejects ambiguous or
outdated replacements. Text inside comments is protected and excluded from
replacement matching. Replies are appended using the originating plugin's
normal thread format.

Writes are restricted to visible vault-relative `.md` paths. Deletion, renaming,
configuration changes, symbolic links, and external actions are excluded.
Unsupported or conflicting changes are reported in the reply. Multi-note edits
are not a transaction: successful changes remain if another change fails or the
request is cancelled. A crash during a write leaves that change marked uncertain;
check the note before issuing a new request to change it.

## CLI restrictions

Comment mode uses a separate restricted launch configuration from overview
callouts. The CLI reads notes; validated changes are written by the plugin.
Custom tool, session, directory and permission arguments are rejected. Currently,
only `-c model_verbosity=low|medium|high` is accepted as an extra argument for
Codex comment runs. Clear incompatible arguments to use mentions.

- Codex uses its read-only sandbox, disables interactive approvals, hooks, apps,
  web search and subagents, and ignores user configuration and execution rules.
  Project `.codex/config.toml` files are rejected. Model/provider routing and
  default model settings are copied from the global configuration through a
  restricted allowlist; executable credential helpers are not loaded. Overview
  callouts retain their existing configuration behavior.
- Claude uses `Read,Grep,Glob`, disables settings sources and slash commands, and
  supplies an empty strict MCP configuration. Install a CLI version supporting
  these flags.
- OpenCode uses `--pure` and a dedicated reader agent with deny-by-default tool
  permissions; only reading and file search are allowed. Its inline permission
  configuration is reserved for comment mode. An older CLI lacking these controls
  fails visibly rather than retrying with broader permissions.

These restrictions do not add model subscriptions or accounts; the selected CLI's
existing authentication is used. Managed enterprise CLI policies may impose
additional restrictions. The plugin does not bypass them.

## Identity, progress and recovery

The versioned bridge exposes availability, source attachment, request submission,
job queries/subscriptions, retry and cancellation. Requests carry a unique ID,
source plugin, note path, persistent comment ID, message, excerpt and thread.
Jobs progress through queued, running, applying, completed, failed or cancelled.
The agent name is captured when each request is submitted.

Discussions reuses its comment IDs. Participating inline comments receive a
hidden `<!-- aio-comment:… -->` marker inside their `%%` block. Generated replies
carry a request marker for idempotent publication. The comment plugins hide this
metadata from displayed text even if AI Overview is later disabled. Ordinary
comments acquire no metadata while integration is unavailable.

AI Overview stores request content, results and per-change outcomes in
`mention-jobs.json` within its plugin directory. This history prevents duplicate
runs in one Obsidian installation across panes and reloads. It is local plugin
data and may be synchronized or backed up with the vault configuration; it does
not provide a distributed lock across separate desktop installations.

The active typing indicator uses three animated dots, with an accessible
agent-name label for screen readers. The latest streamed agent activity appears
beneath the dots in very small, muted text, using the same progress events as
AI callouts. Status appears above the reply composer. While a request is queued
or active, that conversation's reply field and send control are disabled and
greyed out; existing drafts are retained. They unlock when the agent completes,
fails, is cancelled, or the integration disconnects. Activity updates keep the
dots and composers intact. Typing and queue indicators are temporary UI, with accessible status text and
reduced-motion support. Progress updates do not rebuild active composers.
Failures offer Retry. A publication retry reuses the saved answer and does not
repeat completed edits. Restarting does not restart interrupted jobs. Changing or
deleting the initiating comment cancels active work; changing a completed request
does not trigger another run. Disabling either plugin cancels its active jobs and
removes the integration UI. Already-published replies remain normal note content.

## Verification

Automated tests cover mention parsing, optional integration, source input versus
programmatic edits, persistent IDs and duplicate prevention, thread-safe replies,
queue serialization, interruption and publication retry, structured output,
provider subprocess fixtures, protected replacements, path validation and symlink
rejection. Development builds should be checked in an isolated Obsidian vault,
using synthetic notes and a deterministic agent fixture before live model tests.

Configured agent mentions receive a light accent highlight in comment bodies.
Highlighting follows the mention matching rules and disappears when integration
is unavailable. Agent name tags cannot contain spaces; whitespace typed or
pasted into the setting is removed.
