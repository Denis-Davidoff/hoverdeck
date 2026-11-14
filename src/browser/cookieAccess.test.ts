import { test } from 'node:test';
import * as assert from 'node:assert';
import { agentCookieRefusal, listCookies, writeCookies, maxAgentCookies } from './cookieAccess.ts';

test('an agent may set cookies for the page site and its parents only', () => {
	const page = 'https://app.example.com/';
	assert.strictEqual(agentCookieRefusal([{ name: 'a', value: '1', url: page }], page), undefined);
	assert.strictEqual(agentCookieRefusal([{ name: 'a', value: '1', domain: '.example.com' }], page), undefined);
	assert.match(agentCookieRefusal([{ name: 'a', value: '1', domain: 'evil.com' }], page)!, /not for the page's site/);
	assert.match(agentCookieRefusal([{ name: 'a', value: '1', domain: '.com' }], page)!, /not a site/);
	assert.match(agentCookieRefusal([{ name: 'a', value: '1', domain: 'x.com' }], 'file:///etc/hosts')!, /http and https/);
	assert.ok(agentCookieRefusal([], page));
	const many = Array.from({ length: maxAgentCookies + 1 }, (_, i) => ({ name: `c${i}`, value: '1', url: page }));
	assert.match(agentCookieRefusal(many, page)!, /At most/);
});

test('listing never carries values', async () => {
	const cookies = await listCookies(async () => ({ cookies: [
		{ name: 'sid', value: 'secret-value', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: -1, session: true },
	] }), 'https://example.com/');
	assert.strictEqual(cookies[0].valueLength, 12);
	assert.ok(!JSON.stringify(cookies).includes('secret-value'));
	assert.strictEqual(cookies[0].expires, 'session');
});

test('one refused cookie does not stop the rest', async () => {
	const result = await writeCookies(async (_m, p: any) => ({ success: p.name !== 'bad' }), [
		{ name: 'bad', value: '1', domain: 'x.com', sameSite: 'None' },
		{ name: 'ok', value: '2', domain: 'x.com' },
	]);
	assert.strictEqual(result.set, 1);
	assert.match(result.failed[0], /SameSite=None needs Secure/);
});
