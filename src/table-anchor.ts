/** Return a rendered row index only when the source table and DOM agree.
 * Lines are zero-based; the Markdown delimiter has no rendered row. */
export function tableRowIndex(lines: readonly string[], from: number, to: number, line: number, rowCount: number): number | null {
	if (rowCount < 1 || line < from || line > to) return null;
	const strip = (value: string) => value.replace(/^\s*(?:>\s*)*/, "").trim();
	for (let delimiter = from + 1; delimiter <= to; delimiter++) {
		const raw = strip(lines[delimiter] ?? "");
		if (!raw.includes("|")) continue;
		const cells = raw.replace(/^\|/, "").replace(/\|$/, "").split("|");
		if (!cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))) continue;
		const header = delimiter - 1;
		if (!strip(lines[header] ?? "").includes("|")) continue;
		let end = delimiter;
		while (end < to && strip(lines[end + 1] ?? "").includes("|")) end++;
		if (end - header !== rowCount || line < header || line > end || line === delimiter) continue;
		return line === header ? 0 : line - header - 1;
	}
	return null;
}

export function tableRowForLine(table: HTMLTableElement, lines: readonly string[], from: number, to: number, line: number): HTMLTableRowElement | null {
	const index = tableRowIndex(lines, from, to, line, table.rows.length);
	return index === null ? null : table.rows[index] ?? null;
}

/** Reconcile observations: observing every table again on each draw would
 * schedule another initial ResizeObserver notification indefinitely. */
export class TableResizeObserver {
	private tables = new Set<HTMLTableElement>();
	private observer: ResizeObserver;
	constructor(redraw: () => void) { this.observer = new ResizeObserver(redraw); }
	update(tables: Iterable<HTMLTableElement>): void {
		const next = new Set(tables);
		for (const table of this.tables) if (!next.has(table)) this.observer.unobserve(table);
		for (const table of next) if (!this.tables.has(table)) this.observer.observe(table);
		this.tables = next;
	}
	destroy(): void { this.observer.disconnect(); this.tables.clear(); }
}
