/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Favorite sites: their shape, what may be stored, and the edits the Favorites settings tab can
 * ask for. A leaf module — `npm test` loads it directly, so no relative value imports.
 *
 * Every value comes from somewhere untrusted at least once (a page title, a webview message, a
 * stored list an older or newer build wrote), so each is checked on the way in, and a stored list
 * is read entry by entry: a malformed entry is dropped, never repaired.
 */

export interface FavoriteSite {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	/** When it was added, ms since the epoch. */
	readonly added: number;
}

export const favoritesLimit = 200;
export const favoriteTitleLimit = 120;
export const favoriteUrlLimit = 2048;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** A favorite's address: http or https, no credentials, at most `favoriteUrlLimit` characters. */
export function favoriteUrl(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || !raw || raw.length > favoriteUrlLimit) { return undefined; }
	let url: URL;
	try { url = new URL(raw); } catch { return undefined; }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
	if (!url.hostname || url.username || url.password) { return undefined; }
	const href = url.href;
	return href.length > favoriteUrlLimit ? undefined : href;
}

/** A title on one line, control characters out, cut by code point. Empty becomes undefined. */
export function favoriteTitle(raw: unknown): string | undefined {
	if (typeof raw !== 'string') { return undefined; }
	// eslint-disable-next-line no-control-regex
	const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
	if (!flat) { return undefined; }
	const points = Array.from(flat);
	return points.length > favoriteTitleLimit ? points.slice(0, favoriteTitleLimit - 1).join('') + '…' : flat;
}

/** The title shown for a favorite with none: its host. */
export function titleFromUrl(url: string): string {
	try { return new URL(url).host || url; } catch { return url; }
}

/** Two addresses that name one page: the same href, a trailing slash on the path ignored. */
export function sameFavoriteUrl(a: string, b: string): boolean {
	const key = (value: string) => value.replace(/\/(?=$|[?#])/, '');
	return key(a) === key(b);
}

/** A stored list, entry by entry. Anything not an array is no favorites. */
export function readFavorites(raw: unknown): FavoriteSite[] {
	if (!Array.isArray(raw)) { return []; }
	const seen = new Set<string>();
	const out: FavoriteSite[] = [];
	for (const entry of raw) {
		if (out.length >= favoritesLimit) { break; }
		if (!entry || typeof entry !== 'object') { continue; }
		const { id, title, url, added } = entry as Record<string, unknown>;
		const href = favoriteUrl(url);
		const name = favoriteTitle(title);
		if (typeof id !== 'string' || !idPattern.test(id) || seen.has(id) || !href || !name) { continue; }
		seen.add(id);
		out.push({ id, title: name, url: href, added: typeof added === 'number' && Number.isFinite(added) ? added : 0 });
	}
	return out;
}

export type FavoritesAction =
	| { readonly action: 'load' }
	| { readonly action: 'add'; readonly url: string; readonly title?: string }
	| { readonly action: 'addCurrent' }
	| { readonly action: 'remove'; readonly id: string }
	| { readonly action: 'rename'; readonly id: string; readonly title: string }
	| { readonly action: 'setUrl'; readonly id: string; readonly url: string }
	| { readonly action: 'move'; readonly id: string; readonly by: -1 | 1 }
	| { readonly action: 'open'; readonly id: string; readonly where: 'vscode' | 'chrome' }
	| { readonly action: 'setButton'; readonly show: boolean };

/**
 * What the webview sent, checked. `add` and `setUrl` carry the address as typed: the host
 * normalises it (a scheme added) before `favoriteUrl` decides, so only its type and length are
 * checked here.
 */
export function readFavoritesAction(raw: any): FavoritesAction | undefined {
	if (!raw || typeof raw !== 'object') { return undefined; }
	const id = typeof raw.id === 'string' && idPattern.test(raw.id) ? raw.id as string : undefined;
	const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : undefined;
	switch (raw.action) {
		case 'load': return { action: 'load' };
		case 'addCurrent': return { action: 'addCurrent' };
		case 'add': {
			const url = text(raw.url, favoriteUrlLimit);
			if (!url?.trim()) { return undefined; }
			const title = raw.title === undefined ? undefined : text(raw.title, 1000);
			if (raw.title !== undefined && title === undefined) { return undefined; }
			return title === undefined ? { action: 'add', url } : { action: 'add', url, title };
		}
		case 'remove': return id ? { action: 'remove', id } : undefined;
		case 'rename': {
			const title = text(raw.title, 1000);
			return id && title !== undefined ? { action: 'rename', id, title } : undefined;
		}
		case 'setUrl': {
			const url = text(raw.url, favoriteUrlLimit);
			return id && url?.trim() ? { action: 'setUrl', id, url } : undefined;
		}
		case 'move': return id && (raw.by === 1 || raw.by === -1) ? { action: 'move', id, by: raw.by } : undefined;
		case 'setButton': return typeof raw.show === 'boolean' ? { action: 'setButton', show: raw.show } : undefined;
		case 'open': return id && (raw.where === 'vscode' || raw.where === 'chrome') ? { action: 'open', id, where: raw.where } : undefined;
		default: return undefined;
	}
}

export type FavoritesEdit =
	| { readonly kind: 'add'; readonly id: string; readonly url: string; readonly title?: string; readonly added: number }
	| { readonly kind: 'remove'; readonly id: string }
	| { readonly kind: 'rename'; readonly id: string; readonly title: string }
	| { readonly kind: 'setUrl'; readonly id: string; readonly url: string }
	| { readonly kind: 'move'; readonly id: string; readonly by: -1 | 1 };

/** The list after an edit, or the reason it was refused. Addresses are already normalised. */
export function applyFavoritesEdit(list: readonly FavoriteSite[], edit: FavoritesEdit): { list: FavoriteSite[] } | { error: string } {
	const index = edit.kind === 'add' ? -1 : list.findIndex(site => site.id === edit.id);
	if (edit.kind !== 'add' && index < 0) { return { error: 'That favorite no longer exists.' }; }
	const next = list.slice();
	switch (edit.kind) {
		case 'add': {
			const url = favoriteUrl(edit.url);
			if (!url) { return { error: 'Only http and https addresses can be saved as favorites.' }; }
			const existing = list.find(site => sameFavoriteUrl(site.url, url));
			if (existing) { return { error: `Already in favorites as "${existing.title}".` }; }
			if (list.length >= favoritesLimit) { return { error: `Favorites hold at most ${favoritesLimit} sites.` }; }
			if (!idPattern.test(edit.id) || list.some(site => site.id === edit.id)) { return { error: 'Could not add the favorite.' }; }
			next.push({ id: edit.id, url, title: favoriteTitle(edit.title) ?? titleFromUrl(url), added: edit.added });
			return { list: next };
		}
		case 'remove':
			next.splice(index, 1);
			return { list: next };
		case 'rename': {
			const title = favoriteTitle(edit.title);
			if (!title) { return { error: 'A favorite needs a name.' }; }
			next[index] = { ...next[index], title };
			return { list: next };
		}
		case 'setUrl': {
			const url = favoriteUrl(edit.url);
			if (!url) { return { error: 'Only http and https addresses can be saved as favorites.' }; }
			const other = list.find(site => site.id !== edit.id && sameFavoriteUrl(site.url, url));
			if (other) { return { error: `Already in favorites as "${other.title}".` }; }
			next[index] = { ...next[index], url };
			return { list: next };
		}
		case 'move': {
			const to = index + edit.by;
			if (to < 0 || to >= next.length) { return { list: next }; }
			[next[index], next[to]] = [next[to], next[index]];
			return { list: next };
		}
	}
}
