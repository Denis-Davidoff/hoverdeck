import * as assert from 'node:assert';
import { test } from 'node:test';
import { readLoginsAction } from './loginsManager.ts';

test('reads well-formed actions', () => {
	assert.deepStrictEqual(readLoginsAction({ action: 'login', id: 'a1', op: 'copyPassword' }), { action: 'login', id: 'a1', op: 'copyPassword' });
	assert.deepStrictEqual(readLoginsAction({ action: 'deletePasskey', id: 'p' }), { action: 'deletePasskey', id: 'p' });
	assert.deepStrictEqual(readLoginsAction({ action: 'offerAgain', origin: 'https://a.example' }), { action: 'offerAgain', origin: 'https://a.example' });
	assert.deepStrictEqual(readLoginsAction({ action: 'export', extra: 1 }), { action: 'export' });
	assert.deepStrictEqual(readLoginsAction({ action: 'set', key: 'passkeys', value: false }), { action: 'set', key: 'passkeys', value: false });
});

test('refuses malformed actions', () => {
	assert.strictEqual(readLoginsAction(undefined), undefined);
	assert.strictEqual(readLoginsAction({ action: 'login', id: 'a', op: 'reveal' }), undefined);
	assert.strictEqual(readLoginsAction({ action: 'login', id: '', op: 'copyUser' }), undefined);
	assert.strictEqual(readLoginsAction({ action: 'login', id: 'x'.repeat(201), op: 'copyUser' }), undefined);
	assert.strictEqual(readLoginsAction({ action: 'set', key: 'securityGuard', value: true }), undefined);
	assert.strictEqual(readLoginsAction({ action: 'set', key: 'enabled', value: 'true' }), undefined);
	assert.strictEqual(readLoginsAction({ action: 'offerAgain', origin: 5 }), undefined);
	assert.strictEqual(readLoginsAction({ action: 'password', id: 'a' }), undefined);
});

test('no action carries a password', () => {
	const read = readLoginsAction({ action: 'login', id: 'a', op: 'password', password: 'hunter2' });
	assert.ok(read && !('password' in read));
});
