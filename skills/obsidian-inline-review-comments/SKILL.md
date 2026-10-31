---
name: obsidian-inline-review-comments
description: Read, author, and reply to Inline Review Comments in Obsidian using percent-delimited messages, author prefixes, quoted excerpts, and whitespace-based threads. Preserve rendering in prose, tables, lists, and callouts. Excludes Discussions tags and Inline Diff proposals.
---

# Inline Review Comments syntax

The plugin stores review messages in Obsidian's `%% … %%` comments. Edit the note's raw Markdown with the tools available in the current environment; no particular vault, CLI, operating system, or other skill is required.

## Each message has its own delimiters

```markdown
This claim needs a source. %% ::Reviewer:: Please add a citation. %%
%% ::Agent:: Added a source and checked the wording. %%
```

- Write a new authored message as `%% ::Agent:: Reply text %%`, substituting your own identity. Anonymous `%% body %%` comments are supported; preserve existing anonymous messages.
- Put the `::name::` prefix first inside the opening delimiter. A name may contain spaces, but not colons or newlines.
- A reply is a **new complete pair** of `%%` delimiters after the thread's last message. Never extend another message's body, reuse its closing delimiter, or insert between existing messages.
- Keep existing messages and metadata intact. Append by default; editing or removing history requires an explicit request. Resolving a thread deletes its messages rather than archiving them.

Correct, two messages:

```markdown
%% ::Reviewer:: Add an example. %% %% ::Agent:: Added an example. %%
```

Incorrect, merged messages or a reply outside a comment:

```markdown
%% ::Reviewer:: Add an example. ::Agent:: Added an example. %%
%% ::Reviewer:: Add an example. %% ::Agent:: Added an example. %%
```

## Whitespace determines the thread

Comments belong to one thread when the gap is only whitespace with **at most one line break**. Use a single space or one newline between messages. A blank line or intervening prose starts a new thread. Replies belong beside the thread, not at the end of the note unless the thread is already there.

Blank lines **inside** one message are allowed and do not split a thread. Bodies render Markdown; separate paragraphs and lists normally:

```markdown
%% ::Agent:: Updated the guide:

- Added a recovery example.
- Clarified the expected result.

One question remains about the retry limit. %%
```

Do not write a literal `%%` inside a comment body or excerpt: the first such pair closes the message, even inside code written within that message. Use `&#37;&#37;` for literal percent delimiters; a backslash does not protect them from this parser. Comment syntax inside an external inline-code span or fenced code block is a literal example rather than a review message.

## Quote a passage without moving it

An opening message can carry a short excerpt at the start of its body, immediately after the optional author prefix:

```markdown
The timeout is 30 seconds.
%% ::Reviewer:: {quote}The timeout is 30 seconds.{/quote} Does this include retries? %%
%% ::Agent:: Yes. Clarified the total retry window. %%
```

The order is opening `%%`, author, `{quote}excerpt{/quote}`, body, closing `%%`. A quote later in the body is ordinary text. Keep the original passage in place: the excerpt is a copy and does not track later edits. Markdown and multiline excerpts are supported. Use a quote on the thread's opening message; replies normally omit it. Encode literal percent delimiters in a copied excerpt so they cannot close the surrounding comment.

## Stay inside the Markdown container

The surrounding table, list, blockquote, callout, or footnote remains part of the note. Preserve its structure when inserting comments and replies.

### Tables

Keep each table row on one physical line. Inside a cell's comment, store body newlines as `<br>` and literal pipes as `\|`, including pipes in links, quoted excerpts, and code. Do not double-escape an already escaped pipe. Append the reply in the **same cell**, before the cell's closing column separator:

```markdown
| Topic | Status |
| --- | --- |
| Retry | Pending %% ::Reviewer:: Compare A \| B.<br>Which is safer? %% %% ::Agent:: B avoids a duplicate request. %% |
```

Use a space between messages in a cell. Inserting a raw newline or unescaped pipe can split the row or add a column. The plugin decodes `<br>` and `\|` when displaying cell comments; do not decode them in the stored table.

### Blockquotes, callouts, lists, and footnotes

On every added physical line, retain the enclosing quote prefix and continuation indentation. Do not repeat a list bullet for a reply: that would create a new list item. Examples:

```markdown
> [!note] Recovery
> Keep a backup. %% ::Reviewer:: Explain why. %%
> %% ::Agent:: It allows rollback after a failed upgrade. %%

- Retry safely. %% ::Reviewer:: Specify the limit. %%
  %% ::Agent:: Use at most three attempts. %%

[^retry]: Retry policy. %% ::Reviewer:: Add a reference. %%
    %% ::Agent:: Added the reference. %%
```

For nested containers, preserve all enclosing prefixes. A blank line within a multiline callout comment still needs its `>` prefix. The plugin removes container prefixes for display and thread grouping; do not remove them from the note. When uncertain about multiline continuation, append a single-line reply with one space after the last message inside the same container.

## Preserve integration metadata

Some messages include hidden `<!-- aio-comment:… -->` or `<!-- aio-reply:… -->` identity markers. Preserve them exactly, inside their existing message. They do not replace whitespace-based thread boundaries. Ordinary manually authored replies do not need these markers; do not copy another message's ID or fabricate integration state. When discussing such metadata literally inside a body, encode its opening `<` as `&lt;` so it is not mistaken for identity metadata.

A configured `@agent` mention can trigger optional agent execution. Include it only when intentionally requesting that agent; a normal response needs only your author prefix.

## Edit and verify

1. Read the current raw note and identify the entire target thread, including all replies. Recheck its current last message immediately before insertion so concurrent replies remain in order.
2. Insert only your new, fully delimited message after that last message. Use an editor-aware edit for unsaved content or a current-content file transform. Preserve existing comments, source prose, frontmatter, links, block IDs, proposals, metadata, line endings, and the final-newline state.
3. Reread the saved range. Confirm one new message with its own opening and closing `%%`, its author at the start, and no swallowed delimiter from the preceding message. Confirm that the intended thread gained a message without joining a neighboring thread or splitting the original one.
4. Check container prefixes, table row/column boundaries, encoded pipes and line breaks, and that unrelated source remains unchanged. Raw delimiter counts alone cannot distinguish examples in code or detect merged messages.
5. When plugin source is available, use `parseComments` and `groupComments` from `src/parser.ts` to check authors, bodies, quotes, and thread membership. `encodeComment` from `src/comment-context.ts` supplies container-aware encoding when programmatic edits are appropriate.
6. When Obsidian is available, inspect the source and review cards in Source mode, Live Preview, and Reading view, particularly for tables or multiline containers. If visual rendering was not checked, report that limit.

Discussions uses `<comment>` tags and `parent_id` instead of this whitespace model. Inline Diff uses `{++…++}`, `{--…--}`, and `{~~…~>…~~}` for proposed text edits. Do not substitute either format for a review-comment reply.
