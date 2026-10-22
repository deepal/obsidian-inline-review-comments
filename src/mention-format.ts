import { parseComments, groupComments } from "./parser.ts";
import { replyMarkdown } from "./comment-edit.ts";
import type { CommentFormat } from "./mention-client.ts";

export const inlineFormat: CommentFormat = {
	parse: (text) => parseComments(text).map((c) => ({ ...c, id: c.id ?? null, agent: !!c.replyTo })),
	thread: (text, target) => (groupComments(parseComments(text), text).find((t) => t.some((c) => c.from === target.from)) ?? []).map((c) => ({ ...c, id: c.id ?? null })),
	identify: (text, target, id) => text.slice(0, target.to - 2) + ` <!-- aio-comment:${id} --> ` + text.slice(target.to - 2),
	replied: (text, id) => text.includes(`<!-- aio-reply:${id} -->`),
	reply: (text, request, author, body) => {
		const threads = groupComments(parseComments(text), text);
		const thread = threads.find((t) => t.some((c) => c.id === request.commentId));
		if (!thread) throw new Error("The inline comment no longer exists.");
		const end = thread[thread.length - 1].to;
		const safe = body.replace(/%%/g, "&#37;&#37;").replace(/<!-- aio-/g, "&lt;!-- aio-");
		const content = `${safe} <!-- aio-reply:${request.id} -->`;
		const reply = content.includes("\n") ? `\n%%\n::${author}:: ${content}\n%%` : replyMarkdown(author, content);
		return text.slice(0, end) + reply + text.slice(end);
	},
};
