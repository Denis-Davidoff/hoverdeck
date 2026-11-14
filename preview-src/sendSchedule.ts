/**
 * Times for a message scheduled to be sent later: the picker's presets, how a
 * time is shown, and the `datetime-local` field's value. Leaf, under test; the
 * view draws them (`chat.ts`) and the host checks the time again (`validSendTime`).
 */

/** One row of the picker: a time and what to call it. */
export interface SchedulePreset {
	readonly label: string;
	readonly at: number;
}

const minute = 60_000;

/** A time on `day` at `hour`:`minutes`, local. */
function at(day: Date, hour: number, minutes = 0): number {
	const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minutes, 0, 0);
	return d.getTime();
}

/**
 * The picker's quick choices: a few minutes to a couple of hours from now,
 * this evening while it is still ahead, tomorrow morning, and Monday morning
 * from a Friday afternoon or a weekend — where "tomorrow" would be a day off.
 */
export function schedulePresets(now: Date): SchedulePreset[] {
	const t = now.getTime();
	const out: SchedulePreset[] = [
		{ label: 'In 15 minutes', at: t + 15 * minute },
		{ label: 'In 30 minutes', at: t + 30 * minute },
		{ label: 'In 1 hour', at: t + 60 * minute },
		{ label: 'In 2 hours', at: t + 120 * minute },
	];
	const evening = at(now, 18);
	if (evening - t >= 150 * minute) {
		out.push({ label: 'This evening', at: evening });
	}
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	out.push({ label: 'Tomorrow morning', at: at(tomorrow, 9) });
	const day = now.getDay();
	if (day === 5 || day === 6 || day === 0) {
		const ahead = (8 - day) % 7 || 7;
		const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
		if (monday.getDate() !== tomorrow.getDate() || monday.getMonth() !== tomorrow.getMonth()) {
			out.push({ label: 'Monday morning', at: at(monday, 9) });
		}
	}
	return out;
}

function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function hhmm(d: Date): string {
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A send time as a person reads it: "14:30", "Tomorrow 09:00", "Mon 09:00", "3 Dec 09:00". */
export function formatSendTime(time: number, now: Date): string {
	const d = new Date(time);
	if (sameDay(d, now)) {
		return hhmm(d);
	}
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	if (sameDay(d, tomorrow)) {
		return `Tomorrow ${hhmm(d)}`;
	}
	const days = (time - now.getTime()) / (24 * 60 * minute);
	if (days > 0 && days < 6) {
		return `${weekdays[d.getDay()]} ${hhmm(d)}`;
	}
	return `${d.getDate()} ${months[d.getMonth()]} ${hhmm(d)}`;
}

/** How long until it goes: "in 25 min", "in 2 h 5 min", "in 3 days"; "now" once it is due. */
export function untilSend(time: number, now: number): string {
	const left = Math.ceil((time - now) / minute);
	if (left <= 0) {
		return 'now';
	}
	if (left < 60) {
		return `in ${left} min`;
	}
	const hours = Math.floor(left / 60);
	if (hours < 24) {
		const rest = left % 60;
		return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
	}
	const days = Math.round(hours / 24);
	return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The `datetime-local` value for a time, local and to the minute. */
export function localInputValue(time: number): string {
	const d = new Date(time);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value as a time; `undefined` for anything that is not one. */
export function parseLocalInput(value: string): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) {
		return undefined;
	}
	const [y, mo, d, h, mi] = m.slice(1).map(Number);
	const date = new Date(y, mo - 1, d, h, mi, 0, 0);
	// `new Date` rolls an impossible date over (31 Feb is 3 Mar): refuse it instead.
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) {
		return undefined;
	}
	return date.getTime();
}

/** The latest a message may be scheduled for; the host refuses past it too (`validSendTime`, a year and a day). */
export const scheduleHorizonMs = 365 * 24 * 60 * minute;
