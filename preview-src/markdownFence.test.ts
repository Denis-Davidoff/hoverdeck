import * as assert from 'node:assert';
import { test } from 'node:test';
import { fenceEnd } from './markdownFence.ts';

const end = (text: string, nested = false) => {
	const lines = text.split('\n');
	return fenceEnd(lines, 0, { marker: /^\s*(`+|~+)/.exec(lines[0])![1] }, nested);
};

test('fenceEnd: a line with an info string never closes', () => {
	assert.strictEqual(end('```\na\n```text\nb\n```'), 4);
	assert.strictEqual(end('```js\nx\n```'), 2);
});

test('fenceEnd: the closer needs the same character and at least the opener\'s length', () => {
	assert.strictEqual(end('````paste\n```\n````'), 2);
	assert.strictEqual(end('```\n~~~\n`````'), 2);
	assert.strictEqual(end('```\nopen'), 2);
});

test('fenceEnd: a paste block keeps an inner block of the same length', () => {
	const reply = '```paste status\n$ picto-deploy status\n```text\napp-1 ok\n```\nlast releases:\n```\nprose';
	assert.strictEqual(end(reply, true), 6);
	assert.strictEqual(end(reply, false), 4);
	assert.strictEqual(end('````paste\n```bash\nls\n```\n````', true), 4);
});
