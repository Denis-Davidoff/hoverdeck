/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Setting and listing a tab's cookies over CDP. Leaf module, under test: the
 * channel is passed in as `send`.
 *
 * **A cookie's value never leaves here towards a model.** `listCookies` answers
 * names and attributes and the value's length; a session cookie is a password
 * that does not need typing, and a page an agent reads can ask it to send one
 * somewhere. Setting goes the other way and has its own guard — see
 * `agentCookieRefusal` — and a confirmation the extension shows itself.
 */

import type { CookieParam } from '../logins/cookieParse';

/** The same rule as `domainMatches` in `cookieParse.ts`, written twice: a leaf may not value-import another. */
function domainMatches(host: string, domain: string): boolean {
	const d = domain.replace(/^\./, '').toLowerCase();
	const h = host.toLowerCase();
	return h === d || h.endsWith(`.${d}`);
}

export type CdpSend = (method: string, params?: object) => Promise<any>;

/** Per CDP call: `send` has no timeout of its own. */
const callTimeoutMs = 5_000;

export interface CookieWriteResult {
	readonly set: number;
	/** `name (domain): reason` for each cookie the browser refused. */
	readonly failed: readonly string[];
}

/** Sets each cookie on its own, so one the browser refuses does not take the rest with it. */
export async function writeCookies(send: CdpSend, params: readonly CookieParam[]): Promise<CookieWriteResult> {
	let set = 0;
	const failed: string[] = [];
	for (const param of params) {
		const where = param.domain ?? hostOf(param.url) ?? '?';
		try {
			const answer = await bounded(send('Network.setCookie', param));
			// `success` is deprecated and still sent; `false` is a refusal with no reason given.
			if (answer && answer.success === false) {
				failed.push(`${param.name} (${where}): refused by the browser${refusalHint(param)}`);
			} else {
				set++;
			}
		} catch (err) {
			failed.push(`${param.name} (${where}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { set, failed };
}

/** The usual reasons Chrome refuses a cookie without saying which. */
function refusalHint(param: CookieParam): string {
	if (param.sameSite === 'None' && !param.secure) {
		return ' — SameSite=None needs Secure';
	}
	if (param.secure && param.url?.startsWith('http:')) {
		return ' — a Secure cookie on an http address';
	}
	return '';
}

/** One cookie as a model may see it: everything but the value. */
export interface CookieSummary {
	readonly name: string;
	readonly domain: string;
	readonly path: string;
	readonly valueLength: number;
	readonly secure: boolean;
	readonly httpOnly: boolean;
	readonly sameSite?: string;
	/** ISO time, or `session`. */
	readonly expires: string;
}

/** The cookies the browser would send to `url`, without their values. */
export async function listCookies(send: CdpSend, url: string): Promise<CookieSummary[]> {
	const answer = await bounded(send('Network.getCookies', { urls: [url] }));
	const cookies: unknown[] = Array.isArray(answer?.cookies) ? answer.cookies : [];
	return cookies
		.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
		.map(c => ({
			name: String(c.name ?? ''),
			domain: String(c.domain ?? ''),
			path: String(c.path ?? '/'),
			valueLength: typeof c.value === 'string' ? c.value.length : 0,
			secure: c.secure === true,
			httpOnly: c.httpOnly === true,
			sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
			expires: c.session === true || typeof c.expires !== 'number' || c.expires <= 0
				? 'session'
				: new Date(c.expires * 1000).toISOString(),
		}))
		.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/** At most this many cookies per agent call: a paste of a session is a handful. */
export const maxAgentCookies = 50;

/**
 * Why an agent may not set these cookies on this page, or `undefined`.
 *
 * Only for the site the page is on: each cookie's domain must be the page's
 * host or a parent of it with a dot in it — what the page itself could set.
 * An agent told by a page to "log in" elsewhere can then reach no other site,
 * and the confirmation names one site, not a list a person skims.
 */
export function agentCookieRefusal(params: readonly CookieParam[], pageUrl: string): string | undefined {
	let host: string;
	try {
		const page = new URL(pageUrl);
		if (!/^https?:$/.test(page.protocol)) {
			return 'Cookies can be set on http and https pages only.';
		}
		host = page.hostname.toLowerCase();
	} catch {
		return 'The page has no address to set cookies for.';
	}
	if (params.length === 0) {
		return 'No cookies to set.';
	}
	if (params.length > maxAgentCookies) {
		return `At most ${maxAgentCookies} cookies at a time.`;
	}
	for (const param of params) {
		const domain = (param.domain ?? hostOf(param.url) ?? '').replace(/^\./, '').toLowerCase();
		if (!domain || !domainMatches(host, domain)) {
			return `"${param.name}" is for ${domain || 'no domain'}, not for the page's site (${host}). `
				+ 'Cookies can only be set for the site the tab is on — open that site first.';
		}
		if (domain !== host && !domain.includes('.')) {
			return `"${param.name}" is for the whole "${domain}" domain, which is not a site.`;
		}
	}
	return undefined;
}

function hostOf(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

function bounded<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('The browser did not answer in time.')), callTimeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}
