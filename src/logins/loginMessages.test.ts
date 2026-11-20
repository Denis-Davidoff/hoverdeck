/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { readFormMessage } from './loginMessages.ts';

suite('readFormMessage', () => {

	test('a fields report, settled or not', () => {
		const message = { type: 'fields', login: true, password: true, newPassword: false, usernameOnly: false, settled: true };
		assert.deepStrictEqual(readFormMessage(JSON.stringify(message)), message);
		const { settled: _settled, ...early } = message;
		assert.deepStrictEqual(readFormMessage(JSON.stringify(early)), { ...early, settled: false });
	});

	test('a submission, with the username trimmed and the password kept exactly', () => {
		const read = readFormMessage(JSON.stringify({ type: 'submit', kind: 'login', username: ' me ', password: ' p ', newPassword: '' }));
		assert.deepStrictEqual(read, { type: 'submit', kind: 'login', username: 'me', password: ' p ', newPassword: '' });
	});

	test('extra fields a page might smuggle in are dropped', () => {
		const read = readFormMessage(JSON.stringify({ type: 'outcome', result: 'gone', origin: 'https://bank.test' }));
		assert.deepStrictEqual(read, { type: 'outcome', result: 'gone' });
	});

	test('anything malformed is not a message', () => {
		for (const payload of [
			'not json',
			'null',
			JSON.stringify({ type: 'fields', login: 'yes', password: true, newPassword: false, usernameOnly: false }),
			JSON.stringify({ type: 'submit', kind: 'admin', username: '', password: '', newPassword: '' }),
			JSON.stringify({ type: 'submit', kind: 'login', username: 1, password: '', newPassword: '' }),
			JSON.stringify({ type: 'outcome', result: 'maybe' }),
			// "cleared" is not an outcome any more: an emptied box proves nothing.
			JSON.stringify({ type: 'outcome', result: 'cleared' }),
			JSON.stringify({ type: 'fields', login: true, password: true, newPassword: false, usernameOnly: false, settled: 'yes' }),
			JSON.stringify({ type: 'other' }),
		]) {
			assert.strictEqual(readFormMessage(payload), undefined, payload);
		}
	});

	test('a value longer than any real credential is refused', () => {
		const payload = JSON.stringify({ type: 'submit', kind: 'login', username: 'u', password: 'x'.repeat(5000), newPassword: '' });
		assert.strictEqual(readFormMessage(payload), undefined);
	});
	test('the in-page list and offer card report only ids the host minted', () => {
		assert.deepStrictEqual(readFormMessage('{"type":"suggestPick","id":"a1_B-2"}'), { type: 'suggestPick', id: 'a1_B-2' });
		assert.strictEqual(readFormMessage('{"type":"suggestPick","id":"a b"}'), undefined);
		assert.strictEqual(readFormMessage(JSON.stringify({ type: 'suggestPick', id: 'x'.repeat(41) })), undefined);
		assert.deepStrictEqual(readFormMessage('{"type":"suggestAction","action":"manage"}'), { type: 'suggestAction', action: 'manage' });
		assert.strictEqual(readFormMessage('{"type":"suggestAction","action":"fill"}'), undefined);
		assert.deepStrictEqual(readFormMessage('{"type":"offerAnswer","token":"t1","action":"never"}'),
			{ type: 'offerAnswer', token: 't1', action: 'never' });
		assert.strictEqual(readFormMessage('{"type":"offerAnswer","token":"t1","action":"delete"}'), undefined);
		assert.strictEqual(readFormMessage('{"type":"offerAnswer","action":"save"}'), undefined);
	});
});
