/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { formatBytes, isSensitiveFile, maxUploadFiles, uploadPathsArgument, uploadVerdict } from './fileUpload.ts';

const inside = { path: '/p/a.png', outside: false };
const outside = { path: '/tmp/b.png', outside: true };

test('a chat agent follows the approval menu', () => {
	assert.deepStrictEqual(uploadVerdict([inside], { inside: 'auto', outside: 'ask' }, true), { kind: 'allow' });
	assert.deepStrictEqual(uploadVerdict([inside, outside], { inside: 'auto', outside: 'ask' }, true), { kind: 'ask', reason: 'policy' });
	assert.deepStrictEqual(uploadVerdict([inside, outside], { inside: 'auto', outside: 'deny' }, true), { kind: 'deny', category: 'outside' });
	assert.deepStrictEqual(uploadVerdict([inside], { inside: 'deny', outside: 'auto' }, true), { kind: 'deny', category: 'inside' });
});

test('Deny holds with the guard off; Ask does not', () => {
	assert.deepStrictEqual(uploadVerdict([outside], { inside: 'auto', outside: 'deny' }, false), { kind: 'deny', category: 'outside' });
	assert.deepStrictEqual(uploadVerdict([outside], { inside: 'auto', outside: 'ask' }, false), { kind: 'allow' });
});

test('a secret is asked about even under Auto, and an outside caller is always asked', () => {
	assert.deepStrictEqual(uploadVerdict([{ path: '/p/.env', outside: false }], { inside: 'auto', outside: 'auto' }, true), { kind: 'ask', reason: 'sensitive' });
	assert.deepStrictEqual(uploadVerdict([inside], undefined, true), { kind: 'ask', reason: 'noPolicy' });
	assert.deepStrictEqual(uploadVerdict([inside], undefined, false), { kind: 'allow' });
});

test('secret-looking files', () => {
	for (const p of ['/p/.env', '/p/.env.local', '/h/.ssh/config', '/p/server.pem', '/p/id_ed25519', '/h/.aws/credentials', '/p/.npmrc']) {
		assert.ok(isSensitiveFile(p), p);
	}
	for (const p of ['/p/.env.example', '/p/photo.jpg', '/p/keys.txt', '/p/environment.md']) {
		assert.ok(!isSensitiveFile(p), p);
	}
});

test('paths argument', () => {
	assert.deepStrictEqual(uploadPathsArgument(' a.png '), ['a.png']);
	assert.deepStrictEqual(uploadPathsArgument(['a', 'b']), ['a', 'b']);
	assert.throws(() => uploadPathsArgument([]));
	assert.throws(() => uploadPathsArgument([1]));
	assert.throws(() => uploadPathsArgument(['a\nb']));
	assert.throws(() => uploadPathsArgument(Array(maxUploadFiles + 1).fill('a')));
});

test('sizes', () => {
	assert.strictEqual(formatBytes(512), '512 B');
	assert.strictEqual(formatBytes(3482), '3.4 KB');
	assert.strictEqual(formatBytes(12 * 1024 * 1024), '12 MB');
});
