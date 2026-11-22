/**
 * When a turn ran, said the way people say it (asked for): "12:20–12:40 · 15 min ago",
 * "today 09:05–09:40", "yesterday 12:20–12:40", "Mon 18:02–18:10", "Nov 3, 12:20–12:40".
 * A leaf with no DOM, under test; local time, 24-hour clock.
 */

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMs = 86_400_000;

function clock(d: Date): string {
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function midnight(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days from `d` to `now`: 0 today, 1 yesterday. */
function daysBack(d: Date, now: Date): number {
	return Math.round((midnight(now) - midnight(d)) / dayMs);
}

/** The day of `d` as seen from `now`: "today", "yesterday", "Mon", "Nov 3", "Nov 3, 2025". */
export function dayLabel(d: Date, now: Date): string {
	const back = daysBack(d, now);
	if (back <= 0) { return 'today'; }
	if (back === 1) { return 'yesterday'; }
	if (back < 7) { return weekdays[d.getDay()]; }
	const date = `${months[d.getMonth()]} ${d.getDate()}`;
	return d.getFullYear() === now.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** "just now", "15 min ago", "3 h ago" — only for the last twelve hours, else undefined. */
export function relativeAgo(at: number, now: number): string | undefined {
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) { return 'just now'; }
	if (minutes < 60) { return `${minutes} min ago`; }
	const hours = Math.floor(minutes / 60);
	return hours < 12 ? `${hours} h ago` : undefined;
}

/** The span a turn ran over, from its start to its end. */
export function turnSpan(start: number, end: number, now: number): string {
	const s = new Date(start);
	const e = new Date(Math.max(start, end));
	const n = new Date(now);
	const sameDay = midnight(s) === midnight(e);
	const range = sameDay
		? (clock(s) === clock(e) ? clock(s) : `${clock(s)}–${clock(e)}`)
		: `${clock(s)} – ${dayLabel(e, n)} ${clock(e)}`;
	const ago = relativeAgo(e.getTime(), now);
	const day = dayLabel(s, n);
	// Today and recent: the times plus how long ago it ended; the word "today" adds nothing then.
	if (ago && day === 'today' && sameDay) { return `${range} · ${ago}`; }
	return `${day} ${range}`;
}

/** The full dates, for a tooltip. */
export function turnSpanTitle(start: number, end: number): string {
	const f = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
	return `Started ${f(start)}, ended ${f(Math.max(start, end))}`;
}
