/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Paste Cookies into Page… — for a site that refuses to sign in inside the
 * editor's browser (or a Chrome started for debugging): copy the cookies from
 * a browser where the session exists, and set them on this tab.
 *
 * The clipboard is read first, since a multi-line paste (cookies.txt, a JSON
 * export, several Set-Cookie lines) does not fit an input box, which takes one
 * line. When it parses, a picker says what would be set and where; otherwise an
 * input box takes a Cookie header, a cURL command or a JSON array on one line,
 * checking it as it is typed. Nothing goes through a toast (#10): the summary
 * is a QuickPick, the outcome the status bar.
 */

import * as vscode from 'vscode';
import type { BrowserController } from '../browser/browserController';
import { tabs as tabSource } from '../browser/tabSource';
import { productName } from '../core/flavor';
import { confirm, refuse } from '../core/notify';
import { plainInLabel } from '../core/notifyText';
import { formatNames, parseCookies, toCookieParams, type CookieParse } from './cookieParse';

export function registerCookiePaste(context: vscode.ExtensionContext, browser: BrowserController): void {
	context.subscriptions.push(vscode.commands.registerCommand('hoverdeck.pasteCookies', () => pasteCookies(browser)));
}

async function pasteCookies(browser: BrowserController): Promise<void> {
	if (!tabSource.available()) {
		refuse(vscode.l10n.t('Browser API not enabled — run "{0}: Enable Integrated Browser API" from the command palette to paste cookies into a page.', productName()));
		return;
	}
	const tab = browser.userTab;
	if (!tab) {
		refuse(vscode.l10n.t('Open the site in a browser tab first, then paste its cookies.'));
		return;
	}
	let host: string;
	try {
		const page = new URL(tab.url);
		if (!/^https?:$/.test(page.protocol)) {
			throw new Error('scheme');
		}
		host = page.hostname;
	} catch {
		refuse(vscode.l10n.t('Cookies can be set on http and https pages only — open the site first.'));
		return;
	}
	const label = plainInLabel(host);

	let parsed: CookieParse | undefined;
	const clipboard = await vscode.env.clipboard.readText().then(text => text, () => '');
	const fromClipboard = parseCookies(clipboard);
	if (fromClipboard) {
		const choice = await confirmClipboard(fromClipboard, tab.url, label);
		if (choice === 'cancel') {
			return;
		}
		parsed = choice === 'use' ? fromClipboard : undefined;
	}
	if (!parsed) {
		parsed = await askForCookies(label);
		if (!parsed) {
			return;
		}
	}

	const plan = toCookieParams(parsed.cookies, tab.url);
	if (plan.params.length === 0) {
		refuse(vscode.l10n.t('No cookie could be set: {0}', plainInLabel(plan.skipped.slice(0, 3).join('; ') || 'none were valid')));
		return;
	}
	if (!browser.userTab || browser.userTab !== tab) {
		refuse(vscode.l10n.t('The browser tab changed while the cookies were being read — nothing was set.'));
		return;
	}
	try {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('$(symbol-key) Setting cookies on {0}', label) },
			() => browser.setCookiesForUser(tab, plan.params, true));
		if (result.set === 0) {
			refuse(vscode.l10n.t('No cookie was set on {0}: {1}', label, plainInLabel(result.failed.slice(0, 2).join('; '))));
			return;
		}
		const refused = result.failed.length + plan.skipped.length;
		confirm(refused
			? vscode.l10n.t('Set {0} cookies on {1} and reloaded it; {2} were refused or skipped.', result.set, label, refused)
			: vscode.l10n.t('Set {0} cookies on {1} and reloaded it.', result.set, label));
	} catch (err) {
		refuse(vscode.l10n.t('Could not set the cookies: {0}', plainInLabel(err instanceof Error ? err.message : String(err))));
	}
}

type ClipboardChoice = 'use' | 'manual' | 'cancel';

async function confirmClipboard(parsed: CookieParse, pageUrl: string, host: string): Promise<ClipboardChoice> {
	const plan = toCookieParams(parsed.cookies, pageUrl);
	const names = parsed.cookies.slice(0, 8).map(c => plainInLabel(c.name)).join(', ') + (parsed.cookies.length > 8 ? ', …' : '');
	const notes: string[] = [];
	if (plan.otherDomains.length) {
		notes.push(vscode.l10n.t('also for {0}', plainInLabel(plan.otherDomains.slice(0, 3).join(', '))));
	}
	if (!plan.matchesPage) {
		notes.push(vscode.l10n.t('none of them is for {0}', host));
	}
	if (parsed.skipped.length || plan.skipped.length) {
		notes.push(vscode.l10n.t('{0} skipped', parsed.skipped.length + plan.skipped.length));
	}
	interface Item extends vscode.QuickPickItem { readonly choice: ClipboardChoice }
	const items: Item[] = [
		{
			choice: 'use',
			label: vscode.l10n.t('$(symbol-key) Set {0} cookies from the clipboard on {1}', plan.params.length, host),
			description: formatNames[parsed.format],
			detail: [names, ...notes].join(' · '),
		},
		{ choice: 'manual', label: vscode.l10n.t('$(edit) Enter cookies manually…') },
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('Paste cookies into {0}', host),
		placeHolder: vscode.l10n.t('The page is reloaded afterwards'),
		ignoreFocusOut: true,
	});
	return picked?.choice ?? 'cancel';
}

async function askForCookies(host: string): Promise<CookieParse | undefined> {
	const text = await vscode.window.showInputBox({
		title: vscode.l10n.t('Paste cookies into {0}', host),
		prompt: vscode.l10n.t('A Cookie header (a=1; b=2), a cURL command, a Set-Cookie line or a JSON array. For cookies.txt or several lines, copy them and run the command again.'),
		placeHolder: 'session=…; csrftoken=…',
		ignoreFocusOut: true,
		password: false,
		validateInput: value => {
			if (!value.trim()) {
				return vscode.l10n.t('Paste the cookies');
			}
			const parsed = parseCookies(value);
			if (!parsed) {
				return vscode.l10n.t('Not a format that can be read as cookies');
			}
			return { message: vscode.l10n.t('{0}: {1} cookies', formatNames[parsed.format], parsed.cookies.length), severity: vscode.InputBoxValidationSeverity.Info };
		},
	});
	return text ? parseCookies(text) : undefined;
}
