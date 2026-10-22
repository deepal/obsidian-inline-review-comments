/** Optional, versioned protocol. Kept identical in the three independently shipped plugins. */
export const BRIDGE_DISCOVER = "ai-overview:discover-v1";
export const BRIDGE_CHANGED = "ai-overview:bridge-changed-v1";
export type CommentSource = "comment-block" | "inline-review-comment";
export type JobState = "queued" | "running" | "applying" | "completed" | "failed" | "cancelled";
export interface MentionRequest {
	id: string;
	source: CommentSource;
	notePath: string;
	commentId: string;
	message: string;
	quote: string | null;
	excerpt?: string | null;
	thread: Array<{ author: string | null; body: string }>;
}
export interface MentionJob {
	request: MentionRequest;
	tag: string;
	state: JobState;
	error?: string;
	detail?: string;
}
export interface CommentHost {
	validate(request: MentionRequest): Promise<boolean>;
	publish(request: MentionRequest, author: string, body: string): Promise<void>;
}
export interface AgentBridge {
	version: 1;
	readonly tag: string;
	attach(source: CommentSource, host: CommentHost): () => void;
	submit(request: MentionRequest): Promise<void>;
	jobs(source: CommentSource, notePath: string): MentionJob[];
	subscribe(listener: () => void): () => void;
	retry(id: string): Promise<void>;
	cancel(id: string): void;
}


export function isAgentBridge(value: unknown): value is AgentBridge {
	if (!value || typeof value !== "object") return false;
	const candidate = value as AgentBridge;
	return candidate.version === 1 && typeof candidate.tag === "string" &&
		["attach", "submit", "jobs", "subscribe", "retry", "cancel"].every((key) => typeof (value as Record<string, unknown>)[key] === "function");
}

export function normalizeTag(value: unknown): string {
	if (typeof value !== "string") return "";
	const tag = value.trim().replace(/^@/, "");
	return /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(tag) ? tag : "";
}

/** Locate whole prose mentions while preserving offsets in the original message. */
export function mentionRanges(body: string, tag: string): Array<{ from: number; to: number }> {
	if (!normalizeTag(tag)) return [];
	const mask = (text: string) => " ".repeat(text.length);
	const prose = body
		.replace(/^\s*>.*$/gm, mask)
		.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, mask)
		.replace(/(`+)[^\n]*?\1/g, mask)
		.replace(/\[[^\]]*\]\([^)]*\)|<[^>]*>/g, mask);
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|[^\\w@\\\\])@${escaped}(?![\\w-])`, "gi");
	return Array.from(prose.matchAll(pattern), (match) => {
		const from = match.index + match[1].length;
		return { from, to: from + tag.length + 1 };
	});
}

/** Match prose mentions only, excluding quotes, code, links and escaped @ signs. */
export function hasMention(body: string, tag: string): boolean {
	return mentionRanges(body, tag).length > 0;
}

/** Metadata is internal to the %% block; it never becomes display text. */
export function inlineIdentity(body: string): { body: string; id?: string; replyTo?: string } {
	let id: string | undefined;
	let replyTo: string | undefined;
	const clean = body.replace(/<!-- aio-(comment|reply):([a-zA-Z0-9_-]+) -->/g, (_all, kind: string, value: string) => {
		if (kind === "comment") id = value;
		else replyTo = value;
		return "";
	}).trim();
	return { body: clean, ...(id ? { id } : {}), ...(replyTo ? { replyTo } : {}) };
}
