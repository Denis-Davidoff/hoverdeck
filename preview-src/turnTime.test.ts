import * as assert from 'node:assert';
import { test } from 'node:test';
import { dayLabel, relativeAgo, turnSpan } from './turnTime.ts';

const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
const now = at(21, 13, 0); // Sat Nov 21 2026, 13:00

test('recent turn: times and how long ago', () => {
	assert.strictEqual(turnSpan(at(21, 12, 20), at(21, 12, 45), now), '12:20–12:45 · 15 min ago');
	assert.strictEqual(turnSpan(at(21, 12, 59), at(21, 12, 59), at(21, 12, 59) + 10_000), '12:59 · just now');
	assert.strictEqual(turnSpan(at(21, 9, 5), at(21, 9, 40), now), '09:05–09:40 · 3 h ago');
});

test('earlier days', () => {
	assert.strictEqual(turnSpan(at(20, 12, 20), at(20, 12, 40), now), 'yesterday 12:20–12:40');
	assert.strictEqual(turnSpan(at(16, 18, 2), at(16, 18, 10), now), 'Mon 18:02–18:10');
	assert.strictEqual(turnSpan(at(3, 12, 20), at(3, 12, 40), now), 'Nov 3 12:20–12:40');
	assert.strictEqual(dayLabel(new Date(2025, 0, 5), new Date(now)), 'Jan 5, 2025');
});

test('a turn across midnight names both days', () => {
	assert.strictEqual(turnSpan(at(20, 23, 50), at(21, 0, 10), now), 'yesterday 23:50 – today 00:10');
});

test('relativeAgo stops after twelve hours', () => {
	assert.strictEqual(relativeAgo(now - 13 * 3_600_000, now), undefined);
});
