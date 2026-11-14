/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cookies pasted by the user, in whatever shape they were copied — read into
 * `Network.setCookie` parameters. Leaf module, under test: no `vscode`, no
 * relative value imports.
 *
 * Formats read, tried in this order:
 *
 * | Format | Where it comes from |
 * |---|---|
 * | JSON array / object | Cookie-Editor, EditThisCookie, Playwright `storageState` (`{ cookies: [...] }`), Puppeteer `page.cookies()` |
 * | Netscape `cookies.txt` | browser export extensions, `curl -c`, yt-dlp |
 * | cURL command | DevTools → Network → Copy as cURL (`-H 'cookie: …'`, `-b '…'`) |
 * | `Set-Cookie` lines | a response header copied from DevTools |
 * | `Cookie` header / `document.cookie` | `name=value; name2=value2`, optionally prefixed with `Cookie:` |
 *
 * A cookie with no domain of its own (the header forms) is set for the page
 * it is pasted into, as a host-only cookie on `/`.
 */

export type CookieSameSite = 'Strict' | 'Lax' | 'None';

/** A cookie as read, before it is tied to a page. */
export interface PastedCookie {
	readonly name: string;
	readonly value: string;
	/** As written: a leading dot means "and subdomains". Absent: the page's host. */
	readonly domain?: string;
	readonly path?: string;
	readonly secure?: boolean;
	readonly httpOnly?: boolean;
	readonly sameSite?: CookieSameSite;
	/** Seconds since the epoch. Absent: a session cookie. */
	readonly expires?: number;
}

export type CookieFormat = 'json' | 'netscape' | 'curl' | 'setCookie' | 'header';

export interface CookieParse {
	readonly format: CookieFormat;
	readonly cookies: readonly PastedCookie[];
	/** Entries that were read and dropped, with why, for the summary. */
	readonly skipped: readonly string[];
}

/** The CDP `Network.CookieParam` this module produces. */
export interface CookieParam {
	name: string;
	value: string;
	url?: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: CookieSameSite;
	expires?: number;
}

export const formatNames: Record<CookieFormat, string> = {
	json: 'JSON',
	netscape: 'cookies.txt',
	curl: 'cURL',
	setCookie: 'Set-Cookie',
	header: 'Cookie header',
};

/** More than this is not a paste of someone's cookies. */
export const maxCookies = 500;
/** Chrome refuses a name plus value over 4096 bytes; keep the same bound. */
const maxCookieBytes = 4096;
const maxInput = 2_000_000;

/** RFC 6265 token for a name: no controls, separators or whitespace. */
const nameShape = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Reads pasted text. `undefined` when it holds nothing that looks like a
 * cookie in any of the formats — the caller says so rather than guessing.
 */
export function parseCookies(input: string, now = Date.now()): CookieParse | undefined {
	if (typeof input !== 'string') {
		return undefined;
	}
	const text = input.length > maxInput ? input.slice(0, maxInput) : input;
	const trimmed = text.replace(/^\uFEFF/, '').trim();
	if (!trimmed) {
		return undefined;
	}
	const attempts: (() => CookieParse | undefined)[] = [
		() => fromJson(trimmed),
		() => fromNetscape(trimmed),
		() => fromCurl(trimmed),
		() => fromSetCookie(trimmed),
		() => fromHeader(trimmed),
	];
	for (const attempt of attempts) {
		const result = attempt();
		if (result && (result.cookies.length > 0 || result.skipped.length > 0)) {
			return finish(result, now);
		}
	}
	return undefined;
}

/** Drops expired, oversized and malformed cookies; keeps the last of duplicates. */
function finish(result: CookieParse, now: number): CookieParse {
	const skipped = [...result.skipped];
	const kept = new Map<string, PastedCookie>();
	for (const cookie of result.cookies) {
		if (!nameShape.test(cookie.name)) {
			skipped.push(`"${short(cookie.name)}": not a valid cookie name`);
			continue;
		}
		if (/[\u0000-\u001f\u007f;]/.test(cookie.value)) {
			skipped.push(`${cookie.name}: the value holds a character a cookie cannot carry`);
			continue;
		}
		if (utf8Length(cookie.name) + utf8Length(cookie.value) > maxCookieBytes) {
			skipped.push(`${cookie.name}: longer than 4096 bytes`);
			continue;
		}
		if (cookie.expires !== undefined && cookie.expires * 1000 <= now) {
			skipped.push(`${cookie.name}: already expired`);
			continue;
		}
		const key = `${cookie.name}\u0000${(cookie.domain ?? '').replace(/^\./, '').toLowerCase()}\u0000${cookie.path ?? '/'}`;
		kept.delete(key);
		kept.set(key, cookie);
		if (kept.size > maxCookies) {
			skipped.push(`more than ${maxCookies} cookies — the rest were left out`);
			kept.delete(key);
			break;
		}
	}
	return { format: result.format, cookies: [...kept.values()], skipped };
}

// --- JSON -------------------------------------------------------------------

function fromJson(text: string): CookieParse | undefined {
	if (!/^[[{]/.test(text)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	let list: unknown[];
	if (Array.isArray(parsed)) {
		list = parsed;
	} else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)) {
		list = (parsed as { cookies: unknown[] }).cookies;
	} else if (parsed && typeof parsed === 'object' && 'name' in parsed) {
		list = [parsed];
	} else {
		return undefined;
	}
	const cookies: PastedCookie[] = [];
	const skipped: string[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const raw = item as Record<string, unknown>;
		const name = typeof raw.name === 'string' ? raw.name : typeof raw.Name === 'string' ? raw.Name : undefined;
		const valueRaw = raw.value ?? raw.Value;
		if (name === undefined || (typeof valueRaw !== 'string' && typeof valueRaw !== 'number')) {
			skipped.push('an entry with no name or value');
			continue;
		}
		const session = raw.session === true;
		const expiresRaw = raw.expirationDate ?? raw.expires ?? raw.expiry ?? raw.Expires;
		const expires = session ? undefined : jsonExpiry(expiresRaw);
		const domainRaw = typeof raw.domain === 'string' ? raw.domain : typeof raw.Domain === 'string' ? raw.Domain : undefined;
		// Cookie-Editor marks a host-only cookie `hostOnly: true` and still writes
		// its host in `domain`, without the dot — which is how Chrome treats a
		// domain with no dot too, so nothing has to change for it.
		cookies.push({
			name,
			value: String(valueRaw),
			domain: domainRaw?.trim() || undefined,
			path: typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path : undefined,
			secure: raw.secure === true ? true : raw.secure === false ? false : undefined,
			httpOnly: raw.httpOnly === true ? true : raw.httpOnly === false ? false : undefined,
			sameSite: sameSiteOf(raw.sameSite),
			expires,
		});
	}
	return { format: 'json', cookies, skipped };
}

/** Seconds (Chrome extensions, Playwright) or milliseconds or an ISO date. `-1` and `0` mean a session cookie. */
function jsonExpiry(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value <= 0) {
			return undefined;
		}
		// Past year 5000 in seconds, so this is milliseconds.
		return value > 1e11 ? value / 1000 : value;
	}
	if (typeof value === 'string' && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) {
			return jsonExpiry(numeric);
		}
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms / 1000 : undefined;
	}
	return undefined;
}

function sameSiteOf(value: unknown): CookieSameSite | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	switch (value.trim().toLowerCase()) {
		case 'strict': return 'Strict';
		case 'lax': return 'Lax';
		case 'none':
		case 'no_restriction': return 'None';
		default: return undefined; // 'unspecified' and anything else: the browser's default
	}
}

// --- Netscape cookies.txt ---------------------------------------------------

function fromNetscape(text: string): CookieParse | undefined {
	const lines = text.split(/\r?\n/);
	const cookies: PastedCookie[] = [];
	let header = false;
	for (const line of lines) {
		let row = line.trim();
		if (!row) {
			continue;
		}
		let httpOnly = false;
		if (row.startsWith('#HttpOnly_')) {
			httpOnly = true;
			row = row.slice('#HttpOnly_'.length);
		} else if (row.startsWith('#')) {
			header ||= /netscape/i.test(row);
			continue;
		}
		const fields = line.replace(/^\s*(#HttpOnly_)?/, '').split('\t');
		if (fields.length < 7) {
			// One bad line in a real cookies.txt is skipped; text with no tab rows
			// at all is not this format.
			continue;
		}
		const [domain, , path, secure, expiry, name, ...rest] = fields;
		const expiresNumber = Number(expiry.trim());
		cookies.push({
			name: name.trim(),
			value: rest.join('\t').replace(/\r$/, ''),
			domain: domain.trim() || undefined,
			path: path.trim().startsWith('/') ? path.trim() : undefined,
			secure: /^true$/i.test(secure.trim()),
			httpOnly,
			expires: Number.isFinite(expiresNumber) && expiresNumber > 0 ? expiresNumber : undefined,
		});
	}
	return cookies.length > 0 || header ? { format: 'netscape', cookies, skipped: [] } : undefined;
}

// --- cURL -------------------------------------------------------------------

function fromCurl(text: string): CookieParse | undefined {
	if (!/^\s*curl(\.exe)?\s/i.test(text)) {
		return undefined;
	}
	const args = shellWords(text);
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		if ((arg === '-H' || arg === '--header') && next !== undefined) {
			const match = /^\s*cookie\s*:\s*(.*)$/is.exec(next);
			if (match) {
				values.push(match[1]);
			}
			i++;
		} else if ((arg === '-b' || arg === '--cookie') && next !== undefined) {
			// `-b` with no `=` names a file to read; nothing to do with that here.
			if (next.includes('=')) {
				values.push(next);
			}
			i++;
		}
	}
	if (values.length === 0) {
		return { format: 'curl', cookies: [], skipped: ['the cURL command carries no Cookie header'] };
	}
	return { format: 'curl', cookies: values.flatMap(headerPairs), skipped: [] };
}

/**
 * Splits a command the way bash and cmd.exe would for the shapes "Copy as
 * cURL" writes: single quotes, double quotes with backslash escapes, `$'…'`,
 * line continuations (`\`, `^`), and cmd's `^` escapes.
 */
function shellWords(text: string): string[] {
	const words: string[] = [];
	let current = '';
	let inWord = false;
	let i = 0;
	const s = text.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
	while (i < s.length) {
		const c = s[i];
		if (/\s/.test(c)) {
			if (inWord) {
				words.push(current);
				current = '';
				inWord = false;
			}
			i++;
			continue;
		}
		inWord = true;
		if (c === '$' && s[i + 1] === "'") {
			i += 2;
			while (i < s.length && s[i] !== "'") {
				if (s[i] === '\\' && i + 1 < s.length) {
					const e = s[i + 1];
					current += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
					i += 2;
				} else {
					current += s[i++];
				}
			}
			i++;
		} else if (c === "'") {
			const end = s.indexOf("'", i + 1);
			current += s.slice(i + 1, end < 0 ? s.length : end);
			i = end < 0 ? s.length : end + 1;
		} else if (c === '"') {
			i++;
			while (i < s.length && s[i] !== '"') {
				if ((s[i] === '\\' || s[i] === '^') && i + 1 < s.length && /["\\^$`]/.test(s[i + 1])) {
					current += s[i + 1];
					i += 2;
				} else {
					current += s[i++];
				}
			}
			i++;
		} else if ((c === '\\' || c === '^') && i + 1 < s.length) {
			current += s[i + 1];
			i += 2;
		} else {
			current += c;
			i++;
		}
	}
	if (inWord) {
		words.push(current);
	}
	return words;
}

// --- Set-Cookie -------------------------------------------------------------

const attributeNames = /^(path|domain|expires|max-age|secure|httponly|samesite|priority|partitioned)$/i;

function fromSetCookie(text: string): CookieParse | undefined {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const prefixed = lines.some(l => /^set-cookie\s*:/i.test(l));
	// Without the prefix, a line is a Set-Cookie value only if it carries an
	// attribute — `a=1; Path=/` — which a Cookie header never does.
	const withAttributes = lines.every(l => l.split(';').slice(1).some(part => attributeNames.test(part.split('=')[0].trim())));
	if (!prefixed && !withAttributes) {
		return undefined;
	}
	const cookies: PastedCookie[] = [];
	const skipped: string[] = [];
	for (const line of lines) {
		const body = line.replace(/^set-cookie\s*:\s*/i, '');
		if (prefixed && body === line && !/;/.test(line)) {
			continue;
		}
		const [pair, ...attributes] = body.split(';');
		const eq = pair.indexOf('=');
		if (eq <= 0) {
			skipped.push(`"${short(pair.trim())}": no name=value`);
			continue;
		}
		let domain: string | undefined;
		let path: string | undefined;
		let secure: boolean | undefined;
		let httpOnly: boolean | undefined;
		let sameSite: CookieSameSite | undefined;
		let expires: number | undefined;
		let maxAge: number | undefined;
		for (const attribute of attributes) {
			const at = attribute.indexOf('=');
			const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
			const value = at < 0 ? '' : attribute.slice(at + 1).trim();
			switch (key) {
				case 'domain': domain = value || undefined; break;
				case 'path': path = value.startsWith('/') ? value : undefined; break;
				case 'secure': secure = true; break;
				case 'httponly': httpOnly = true; break;
				case 'samesite': sameSite = sameSiteOf(value); break;
				case 'expires': {
					const ms = Date.parse(value);
					if (Number.isFinite(ms)) { expires = ms / 1000; }
					break;
				}
				case 'max-age': {
					const seconds = Number(value);
					if (Number.isFinite(seconds)) { maxAge = seconds; }
					break;
				}
			}
		}
		cookies.push({
			name: pair.slice(0, eq).trim(),
			value: unquote(pair.slice(eq + 1).trim()),
			domain, path, secure, httpOnly, sameSite,
			// Max-Age wins over Expires (RFC 6265 §5.3); relative to now, resolved in `toCookieParams`.
			expires: maxAge !== undefined ? -maxAge - 1 : expires,
		});
	}
	return { format: 'setCookie', cookies: cookies.map(resolveMaxAge), skipped };
}

/** Max-Age is carried as a negative marker until the time is known. */
let maxAgeNow = Date.now;
function resolveMaxAge(cookie: PastedCookie): PastedCookie {
	if (cookie.expires === undefined || cookie.expires >= 0) {
		return cookie;
	}
	const seconds = -cookie.expires - 1;
	return { ...cookie, expires: seconds <= 0 ? 0 : maxAgeNow() / 1000 + seconds };
}

/** For tests: the clock Max-Age is counted from. */
export function setMaxAgeClock(clock: () => number): void {
	maxAgeNow = clock;
}

// --- Cookie header ----------------------------------------------------------

function fromHeader(text: string): CookieParse | undefined {
	const body = text.replace(/^cookie\s*:\s*/i, '').replace(/\r?\n/g, ';');
	const cookies = headerPairs(body);
	return cookies.length > 0 ? { format: 'header', cookies, skipped: [] } : undefined;
}

function headerPairs(body: string): PastedCookie[] {
	const cookies: PastedCookie[] = [];
	for (const part of body.split(';')) {
		const eq = part.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const name = part.slice(0, eq).trim();
		if (!name) {
			continue;
		}
		cookies.push({ name, value: unquote(part.slice(eq + 1).trim()) });
	}
	return cookies;
}

// --- turning cookies into CDP parameters ------------------------------------

export interface CookiePlan {
	readonly params: readonly CookieParam[];
	/** Cookies whose domain is not the page's site, by domain, for the summary. */
	readonly otherDomains: readonly string[];
	/** Whether any cookie applies to the page it is pasted into. */
	readonly matchesPage: boolean;
	readonly skipped: readonly string[];
}

/**
 * Ties parsed cookies to the page they are pasted into. Cookies without a
 * domain become host-only cookies of the page; `__Host-` cookies are always
 * host-only and secure on `/`, `__Secure-` ones secure, as the browser
 * requires — otherwise it refuses them in silence.
 */
export function toCookieParams(cookies: readonly PastedCookie[], pageUrl: string): CookiePlan {
	let page: URL | undefined;
	try {
		page = new URL(pageUrl);
	} catch {
		page = undefined;
	}
	const pageHost = page && /^https?:$/.test(page.protocol) ? page.hostname.toLowerCase() : undefined;
	const pageSecure = page?.protocol === 'https:';
	const params: CookieParam[] = [];
	const others = new Set<string>();
	const skipped: string[] = [];
	let matchesPage = false;
	for (const cookie of cookies) {
		const hostPrefix = cookie.name.startsWith('__Host-');
		const securePrefix = hostPrefix || cookie.name.startsWith('__Secure-');
		const domain = hostPrefix ? undefined : cookie.domain?.trim().toLowerCase();
		if (!domain) {
			if (!pageHost || !page) {
				skipped.push(`${cookie.name}: no domain, and the page is not an http(s) page`);
				continue;
			}
			matchesPage = true;
			const secure = securePrefix || (cookie.secure ?? (pageSecure && cookie.sameSite === 'None'));
			params.push(compact({
				name: cookie.name,
				value: cookie.value,
				url: `${page.protocol}//${page.host}/`,
				path: hostPrefix ? '/' : cookie.path ?? '/',
				secure: secure || undefined,
				httpOnly: cookie.httpOnly,
				sameSite: cookie.sameSite,
				expires: cookie.expires,
			}));
			continue;
		}
		const bare = domain.replace(/^\./, '');
		if (!/^[a-z0-9.-]+$/.test(bare) && !/^\[[0-9a-f:]+\]$/.test(bare)) {
			skipped.push(`${cookie.name}: "${short(domain)}" is not a domain`);
			continue;
		}
		if (pageHost && domainMatches(pageHost, bare)) {
			matchesPage = true;
		} else {
			others.add(bare);
		}
		const secure = securePrefix || cookie.secure === true;
		// `url` tells Chrome the scheme the cookie is meant for: a secure cookie
		// set without one, on an http page, is otherwise refused.
		params.push(compact({
			name: cookie.name,
			value: cookie.value,
			domain,
			url: `${secure ? 'https' : 'http'}://${bare}${cookie.path ?? '/'}`,
			path: cookie.path ?? '/',
			secure: secure || undefined,
			httpOnly: cookie.httpOnly,
			sameSite: cookie.sameSite,
			expires: cookie.expires,
		}));
	}
	return { params, otherDomains: [...others].sort(), matchesPage, skipped };
}

/** Whether a cookie for `domain` is sent to `host`: the same host, or a subdomain of it. */
export function domainMatches(host: string, domain: string): boolean {
	const d = domain.replace(/^\./, '').toLowerCase();
	const h = host.toLowerCase();
	return h === d || h.endsWith(`.${d}`);
}

// --- helpers ----------------------------------------------------------------

function compact(param: CookieParam): CookieParam {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(param)) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out as unknown as CookieParam;
}

function unquote(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function short(value: string): string {
	const flat = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
	return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

function utf8Length(value: string): number {
	let bytes = 0;
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}
