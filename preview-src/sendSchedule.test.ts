import { test } from 'node:test';
import * as assert from 'node:assert';
import { formatSendTime, localInputValue, parseLocalInput, schedulePresets, untilSend } from './sendSchedule.ts';

const wed = new Date(2026, 10, 11, 10, 0); // Wednesday 11 Nov 2026, 10:00

test('presets: minutes ahead, the evening while it is ahead, tomorrow morning', () => {
	const labels = schedulePresets(wed).map(p => p.label);
	assert.deepStrictEqual(labels, ['In 15 minutes', 'In 30 minutes', 'In 1 hour', 'In 2 hours', 'This evening', 'Tomorrow morning']);
	const tomorrow = schedulePresets(wed).find(p => p.label === 'Tomorrow morning')!;
	assert.strictEqual(localInputValue(tomorrow.at), '2026-11-12T09:00');
});

test('no evening once it is close; Monday from a Friday', () => {
	const friday = new Date(2026, 10, 13, 17, 0);
	const labels = schedulePresets(friday).map(p => p.label);
	assert.ok(!labels.includes('This evening'));
	const monday = schedulePresets(friday).find(p => p.label === 'Monday morning')!;
	assert.strictEqual(localInputValue(monday.at), '2026-11-16T09:00');
	// Sunday: tomorrow is Monday, so it is not offered twice.
	const sunday = new Date(2026, 10, 15, 12, 0);
	assert.ok(!schedulePresets(sunday).some(p => p.label === 'Monday morning'));
});

test('a send time as a person reads it', () => {
	assert.strictEqual(formatSendTime(new Date(2026, 10, 11, 14, 30).getTime(), wed), '14:30');
	assert.strictEqual(formatSendTime(new Date(2026, 10, 12, 9, 0).getTime(), wed), 'Tomorrow 09:00');
	assert.strictEqual(formatSendTime(new Date(2026, 10, 14, 9, 0).getTime(), wed), 'Sat 09:00');
	assert.strictEqual(formatSendTime(new Date(2026, 11, 3, 9, 5).getTime(), wed), '3 Dec 09:05');
});

test('how long until it goes', () => {
	const now = wed.getTime();
	assert.strictEqual(untilSend(now - 1, now), 'now');
	assert.strictEqual(untilSend(now + 25 * 60_000, now), 'in 25 min');
	assert.strictEqual(untilSend(now + 125 * 60_000, now), 'in 2 h 5 min');
	assert.strictEqual(untilSend(now + 120 * 60_000, now), 'in 2 h');
	assert.strictEqual(untilSend(now + 3 * 24 * 3600_000, now), 'in 3 days');
});

test('datetime-local round trip, and impossible dates refused', () => {
	const t = new Date(2026, 1, 3, 7, 9).getTime();
	assert.strictEqual(parseLocalInput(localInputValue(t)), t);
	assert.strictEqual(parseLocalInput('2026-02-31T09:00'), undefined);
	assert.strictEqual(parseLocalInput('tomorrow'), undefined);
	assert.strictEqual(parseLocalInput(''), undefined);
});
