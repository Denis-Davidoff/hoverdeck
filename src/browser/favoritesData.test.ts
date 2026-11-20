import * as assert from 'node:assert';
import { test } from 'node:test';
import { applyFavoritesEdit, favoriteTitle, favoriteUrl, readFavorites, readFavoritesAction, sameFavoriteUrl, type FavoriteSite } from './favoritesData.ts';

test('favoriteUrl takes http and https only, without credentials', () => {
	assert.strictEqual(favoriteUrl('https://example.com'), 'https://example.com/');
	assert.strictEqual(favoriteUrl('http://localhost:3000/a?b=1'), 'http://localhost:3000/a?b=1');
	assert.strictEqual(favoriteUrl('javascript:alert(1)'), undefined);
	assert.strictEqual(favoriteUrl('file:///etc/hosts'), undefined);
	assert.strictEqual(favoriteUrl('https://user:pw@example.com'), undefined);
	assert.strictEqual(favoriteUrl('example.com'), undefined);
	assert.strictEqual(favoriteUrl('https://a.com/' + 'x'.repeat(3000)), undefined);
	assert.strictEqual(favoriteUrl(5), undefined);
});

test('favoriteTitle keeps one line and cuts by code point', () => {
	assert.strictEqual(favoriteTitle('  A\nB\u2028C  '), 'A B C');
	assert.strictEqual(favoriteTitle('   '), undefined);
	const long = favoriteTitle('😀'.repeat(200))!;
	assert.strictEqual(Array.from(long).length, 120);
	assert.ok(!/[\ud800-\udbff]$/.test(long.slice(0, -1)));
});

test('sameFavoriteUrl ignores a trailing slash', () => {
	assert.ok(sameFavoriteUrl('https://a.com/', 'https://a.com'));
	assert.ok(sameFavoriteUrl('https://a.com/x/?q', 'https://a.com/x?q'));
	assert.ok(!sameFavoriteUrl('https://a.com/x', 'https://a.com/y'));
});

test('readFavorites drops malformed and repeated entries', () => {
	const list = readFavorites([
		{ id: 'a', title: 'A', url: 'https://a.com/', added: 1 },
		{ id: 'a', title: 'Again', url: 'https://b.com/', added: 2 },
		{ id: 'b', title: 'Bad', url: 'ftp://b.com/' },
		{ id: 'c d', title: 'C', url: 'https://c.com/' },
		{ id: 'e', title: '', url: 'https://e.com/' },
		null, 'x',
		{ id: 'f', title: 'F', url: 'https://f.com/', added: 'now' },
	]);
	assert.deepStrictEqual(list.map(site => site.id), ['a', 'f']);
	assert.strictEqual(list[1].added, 0);
	assert.deepStrictEqual(readFavorites({}), []);
});

test('readFavoritesAction checks every field', () => {
	assert.deepStrictEqual(readFavoritesAction({ action: 'add', url: 'example.com' }), { action: 'add', url: 'example.com' });
	assert.deepStrictEqual(readFavoritesAction({ action: 'open', id: 'a', where: 'chrome' }), { action: 'open', id: 'a', where: 'chrome' });
	assert.deepStrictEqual(readFavoritesAction({ action: 'move', id: 'a', by: -1 }), { action: 'move', id: 'a', by: -1 });
	assert.strictEqual(readFavoritesAction({ action: 'add', url: '  ' }), undefined);
	assert.strictEqual(readFavoritesAction({ action: 'add', url: 'a.com', title: 5 }), undefined);
	assert.strictEqual(readFavoritesAction({ action: 'open', id: 'a', where: 'firefox' }), undefined);
	assert.strictEqual(readFavoritesAction({ action: 'move', id: 'a', by: 2 }), undefined);
	assert.strictEqual(readFavoritesAction({ action: 'remove', id: '../x' }), undefined);
	assert.deepStrictEqual(readFavoritesAction({ action: 'setButton', show: false }), { action: 'setButton', show: false });
	assert.strictEqual(readFavoritesAction({ action: 'setButton', show: 'no' }), undefined);
	assert.strictEqual(readFavoritesAction({ action: 'nope' }), undefined);
});

test('applyFavoritesEdit adds, refuses duplicates, renames, moves and removes', () => {
	let list: FavoriteSite[] = [];
	const add = (id: string, url: string, title?: string) => {
		const result = applyFavoritesEdit(list, { kind: 'add', id, url, title, added: 1 });
		if ('list' in result) { list = result.list; }
		return result;
	};
	assert.ok('list' in add('a', 'https://a.com/', 'A'));
	assert.ok('list' in add('b', 'https://b.com/'));
	assert.strictEqual(list[1].title, 'b.com');
	assert.ok('error' in add('c', 'https://a.com'));
	assert.ok('error' in add('d', 'http://x.com:99999'));
	assert.ok('error' in add('a', 'https://z.com/'));
	const moved = applyFavoritesEdit(list, { kind: 'move', id: 'b', by: -1 });
	assert.ok('list' in moved && moved.list[0].id === 'b');
	const renamed = applyFavoritesEdit(list, { kind: 'rename', id: 'a', title: 'New' });
	assert.ok('list' in renamed && renamed.list[0].title === 'New');
	assert.ok('error' in applyFavoritesEdit(list, { kind: 'rename', id: 'a', title: ' ' }));
	assert.ok('error' in applyFavoritesEdit(list, { kind: 'setUrl', id: 'b', url: 'https://a.com/' }));
	const removed = applyFavoritesEdit(list, { kind: 'remove', id: 'a' });
	assert.ok('list' in removed && removed.list.length === 1);
	assert.ok('error' in applyFavoritesEdit(list, { kind: 'remove', id: 'zz' }));
});
