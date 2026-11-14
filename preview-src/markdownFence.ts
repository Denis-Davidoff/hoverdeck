/**
 * Where a fenced block of a chat reply ends (leaf, under test).
 *
 * A closing fence is CommonMark's: the opener's character, at least as many of
 * it, and nothing else on the line. A line such as "```text" opens; it never
 * closes. Matching any line that merely starts with the opener's backticks
 * closed a ```paste block on its first inner "```text", which left the paste
 * frame empty and the rest of the block as prose.
 *
 * With `nested`, used for paste blocks (whose content is Markdown), a fence
 * with an info string inside the block opens an inner block, and the next bare
 * fence closes that one rather than the outer block: models often wrap a code
 * block in a ```paste block of the same length instead of using four backticks.
 */

export interface FenceOpener {
	/** The run of backticks or tildes that opened the block. */
	readonly marker: string;
}

const fenceLine = /^\s*(`{3,}|~{3,})\s*(.*)$/;

/** The index of the line that closes the block opened at `start`, or `lines.length` when none does. */
export function fenceEnd(lines: readonly string[], start: number, opener: FenceOpener, nested = false): number {
	const char = opener.marker[0];
	let inner: string | undefined;
	for (let i = start + 1; i < lines.length; i++) {
		const match = fenceLine.exec(lines[i]);
		if (!match) {
			continue;
		}
		const run = match[1];
		const info = match[2].trim();
		if (inner) {
			if (!info && run[0] === inner[0] && run.length >= inner.length) {
				inner = undefined;
			}
			continue;
		}
		if (!info && run[0] === char && run.length >= opener.marker.length) {
			return i;
		}
		if (nested && info) {
			inner = run;
		}
	}
	return lines.length;
}
