export interface InlineReviewSettings {
	enabled: boolean;
	cardWidth: number;
	hideCommentMarkers: boolean;
	username: string;
	autoInsertOnType: boolean;
	overrideToggleComment: boolean;
}

export const DEFAULT_SETTINGS: InlineReviewSettings = {
	enabled: true,
	cardWidth: 240,
	hideCommentMarkers: true,
	username: "",
	autoInsertOnType: true,
	overrideToggleComment: true,
};

/** Only recognized, well-typed values may override defaults. */
export function normalizeSettings(raw: unknown): InlineReviewSettings {
	const data = raw !== null && typeof raw === "object" && !Array.isArray(raw)
		? raw as Record<string, unknown> : {};
	return {
		enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled,
		username: typeof data.username === "string" ? data.username : DEFAULT_SETTINGS.username,
		cardWidth: typeof data.cardWidth === "number" && Number.isFinite(data.cardWidth)
			? Math.min(360, Math.max(180, Math.round(data.cardWidth / 10) * 10)) : DEFAULT_SETTINGS.cardWidth,
		hideCommentMarkers: typeof data.hideCommentMarkers === "boolean" ? data.hideCommentMarkers : DEFAULT_SETTINGS.hideCommentMarkers,
		autoInsertOnType: typeof data.autoInsertOnType === "boolean" ? data.autoInsertOnType : DEFAULT_SETTINGS.autoInsertOnType,
		overrideToggleComment: typeof data.overrideToggleComment === "boolean" ? data.overrideToggleComment : DEFAULT_SETTINGS.overrideToggleComment,
	};
}
