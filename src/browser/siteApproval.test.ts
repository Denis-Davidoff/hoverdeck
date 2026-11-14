import * as assert from 'node:assert';
import { test } from 'node:test';
import { addressForQuestion, isKnownSite, isLoopbackHost, siteOf } from './siteApproval.ts';

test('loopback hosts are always known', () => {
	for (const h of ['localhost', '127.0.0.1', '127.3.2.1', '[::1]', 'app.localhost']) {
		assert.ok(isLoopbackHost(h), h);
		assert.ok(isKnownSite(h, []), h);
	}
	assert.ok(!isLoopbackHost('localhost.example.com'));
});

test('a subdomain of an approved site is known, its parent is not', () => {
	assert.ok(isKnownSite('docs.example.com', ['example.com']));
	assert.ok(isKnownSite('www.example.com', ['example.com']));
	assert.ok(isKnownSite('example.com', ['www.example.com']));
	assert.ok(!isKnownSite('github.io', ['user.github.io']));
	assert.ok(!isKnownSite('notexample.com', ['example.com']));
	assert.ok(!isKnownSite('example.com.attacker.net', ['example.com']));
});

test('site keys ignore case, www and a trailing dot', () => {
	assert.strictEqual(siteOf('WWW.Example.COM.'), 'example.com');
});

test('www. is not dropped onto a public or shared suffix', () => {
	assert.ok(!isKnownSite('evil.co.uk', ['www.co.uk']));
	assert.ok(!isKnownSite('evil.github.io', ['www.github.io']));
	assert.ok(!isKnownSite('evil.com', ['www.com']));
	assert.strictEqual(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
	assert.ok(isKnownSite('news.bbc.co.uk', ['www.bbc.co.uk']));
});

test('a long address is cut with a count, not silently', () => {
	const url = 'https://a.example/?d=' + 'x'.repeat(500);
	const shown = addressForQuestion(url, 100);
	assert.ok(shown.startsWith('https://a.example/?d='));
	assert.match(shown, /more characters\)$/);
	assert.strictEqual(addressForQuestion('https://a.example/'), 'https://a.example/');
});
