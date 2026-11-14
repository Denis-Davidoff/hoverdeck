import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseCookies, toCookieParams, domainMatches } from './cookieParse.ts';

const now = Date.UTC(2026, 10, 13) ;
const nowSec = Math.floor(now / 1000);

test('a Cookie header', () => {
	const p = parseCookies('Cookie: session=abc123; csrftoken=x%3Dy', now)!;
	assert.strictEqual(p.format, 'header');
	assert.deepStrictEqual(p.cookies.map(c => [c.name, c.value]), [['session', 'abc123'], ['csrftoken', 'x%3Dy']]);
});

test('a bare header without the prefix', () => {
	const p = parseCookies('a=1; b=2', now)!;
	assert.strictEqual(p.format, 'header');
	assert.strictEqual(p.cookies.length, 2);
});

test('a JSON export from a browser extension', () => {
	const json = JSON.stringify([
		{ name: 'sid', value: 'v1', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: nowSec + 3600 },
		{ name: 'tmp', value: 'v2', domain: 'example.com', session: true },
	]);
	const p = parseCookies(json, now)!;
	assert.strictEqual(p.format, 'json');
	assert.strictEqual(p.cookies[0].sameSite, 'None');
	assert.strictEqual(p.cookies[0].expires, nowSec + 3600);
	assert.strictEqual(p.cookies[1].expires, undefined);
});

test('Playwright storage state', () => {
	const p = parseCookies(JSON.stringify({ cookies: [{ name: 'a', value: '1', domain: 'x.com', path: '/', expires: -1 }], origins: [] }), now)!;
	assert.strictEqual(p.format, 'json');
	assert.strictEqual(p.cookies[0].name, 'a');
});

test('cookies.txt', () => {
	const text = [
		'# Netscape HTTP Cookie File',
		`.example.com\tTRUE\t/\tTRUE\t${nowSec + 100}\tsid\tabc`,
		`#HttpOnly_example.com\tFALSE\t/\tFALSE\t0\ttok\txyz`,
	].join('\n');
	const p = parseCookies(text, now)!;
	assert.strictEqual(p.format, 'netscape');
	assert.strictEqual(p.cookies.length, 2);
	assert.strictEqual(p.cookies[1].httpOnly, true);
});

test('a cURL command', () => {
	const p = parseCookies(`curl 'https://example.com/api' -H 'accept: */*' -H 'cookie: a=1; b=2' --compressed`, now)!;
	assert.strictEqual(p.format, 'curl');
	assert.deepStrictEqual(p.cookies.map(c => c.name), ['a', 'b']);
});

test('Set-Cookie lines', () => {
	const p = parseCookies('Set-Cookie: sid=abc; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=Lax\nSet-Cookie: x=1; Max-Age=60', now)!;
	assert.strictEqual(p.format, 'setCookie');
	assert.strictEqual(p.cookies[0].secure, true);
	assert.strictEqual(p.cookies[0].sameSite, 'Lax');
});

test('expired cookies are skipped, not set', () => {
	const p = parseCookies(JSON.stringify([{ name: 'old', value: '1', domain: 'x.com', expirationDate: nowSec - 10 }, { name: 'ok', value: '2', domain: 'x.com' }]), now)!;
	assert.deepStrictEqual(p.cookies.map(c => c.name), ['ok']);
	assert.strictEqual(p.skipped.length, 1);
});

test('text that is not cookies', () => {
	assert.strictEqual(parseCookies('hello world', now), undefined);
	assert.strictEqual(parseCookies('', now), undefined);
});

test('a cookie without a domain becomes host-only for the page', () => {
	const p = parseCookies('a=1', now)!;
	const plan = toCookieParams(p.cookies, 'https://app.example.com/login');
	assert.strictEqual(plan.params[0].url, 'https://app.example.com/');
	assert.strictEqual(plan.params[0].domain, undefined);
	assert.strictEqual(plan.matchesPage, true);
});

test('__Host- cookies are host-only, secure, on /', () => {
	const p = parseCookies(JSON.stringify([{ name: '__Host-s', value: '1', domain: '.example.com', path: '/x' }]), now)!;
	const plan = toCookieParams(p.cookies, 'https://example.com/');
	assert.strictEqual(plan.params[0].domain, undefined);
	assert.strictEqual(plan.params[0].secure, true);
	assert.strictEqual(plan.params[0].path, '/');
});

test('cookies for another site are reported', () => {
	const p = parseCookies(JSON.stringify([{ name: 'a', value: '1', domain: '.other.com' }]), now)!;
	const plan = toCookieParams(p.cookies, 'https://example.com/');
	assert.deepStrictEqual(plan.otherDomains, ['other.com']);
	assert.strictEqual(plan.matchesPage, false);
});

test('domainMatches', () => {
	assert.ok(domainMatches('a.example.com', '.example.com'));
	assert.ok(!domainMatches('badexample.com', 'example.com'));
});
