/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Favorite sites: the store in `globalState` (every window and project share one list), and the
 * three commands of the browser tab's dropdown — Add to Favorites…, Open Favorite… (inside the
 * Favorites ▸ submenu) and Manage Favorites. The chat's Favorites settings tab and its browser
 * button read the same store through `favoriteSites()`.
 *
 * A menu contributed in `package.json` is static, so the sites themselves cannot be rows of the
 * native submenu: the submenu holds a picker instead.
 *
 * The optional star beside the dropdown (`hoverdeck.favorites.showButton`) is two commands, an
 * outlined and a filled one, since a toolbar icon is static: `hoverdeck.pageIsFavorite` says
 * which one shows, republished when the tab in front, its address or the list changes.
 */

import * as vscode from 'vscode';
import { generateUuid } from '../core/uuid';
import { normalizeAddress } from '../core/webUrl';
import { confirm, refuse } from '../core/notify';
import { plainInLabel } from '../core/notifyText';
import { pageTitle } from '../translate/translateText';
import { applyFavoritesEdit, favoriteUrl, readFavorites, sameFavoriteUrl, type FavoriteSite, type FavoritesEdit } from './favoritesData';
import type { BrowserController } from './browserController';

const storeKey = 'hoverdeck.favorites';
const pageIsFavoriteKey = 'hoverdeck.pageIsFavorite';
export const showButtonSetting = 'favorites.showButton';

/** Whether the star shows on the browser tab. */
export function favoritesButtonShown(): boolean {
	return vscode.workspace.getConfiguration('hoverdeck').get<boolean>(showButtonSetting) !== false;
}

export class FavoriteSites implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;
	/** Edits run one after another, so two quick clicks cannot write over each other. */
	private _chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly _state: vscode.Memento) { }

	public list(): FavoriteSite[] {
		return readFavorites(this._state.get(storeKey));
	}

	/** Applies an edit; resolves to the reason it was refused, or `undefined`. */
	public edit(edit: FavoritesEdit): Promise<string | undefined> {
		const run = this._chain.then(async () => {
			const result = applyFavoritesEdit(this.list(), edit);
			if ('error' in result) { return result.error; }
			await this._state.update(storeKey, result.list);
			this._onDidChange.fire();
			return undefined;
		});
		this._chain = run.catch(() => undefined);
		return run;
	}

	/** Adds an address as typed (a scheme supplied where missing). */
	public add(typed: string, title?: string): Promise<string | undefined> {
		const url = normalizeTyped(typed);
		if (!url) { return Promise.resolve('Enter an http or https address, for example example.com.'); }
		return this.edit({ kind: 'add', id: generateUuid().replace(/-/g, ''), url, title, added: Date.now() });
	}

	public setUrl(id: string, typed: string): Promise<string | undefined> {
		const url = normalizeTyped(typed);
		if (!url) { return Promise.resolve('Enter an http or https address, for example example.com.'); }
		return this.edit({ kind: 'setUrl', id, url });
	}

	public find(id: string): FavoriteSite | undefined {
		return this.list().find(site => site.id === id);
	}

	public findUrl(url: string): FavoriteSite | undefined {
		return this.list().find(site => sameFavoriteUrl(site.url, url));
	}

	public dispose(): void {
		this._onDidChange.dispose();
	}
}

/** What was typed, as an http(s) address, or `undefined`. */
export function normalizeTyped(typed: string): string | undefined {
	const address = normalizeAddress(typed);
	return address ? favoriteUrl(address) : undefined;
}

let store: FavoriteSites | undefined;

export function favoriteSites(): FavoriteSites | undefined {
	return store;
}

/** Shows the chat's Favorites settings tab; `false` where the chat cannot open. */
type ManagerOpener = () => Promise<boolean>;
let openManager: ManagerOpener | undefined;

export function setFavoritesManagerOpener(opener: ManagerOpener): void {
	openManager = opener;
}

/** The page a user command is about, or `undefined` with the reason already shown. */
function currentPage(browser: BrowserController): { url: string; title: string } | undefined {
	const tab = browser.userTab;
	if (!tab) {
		refuse(vscode.l10n.t('Open the page in a browser tab first.'));
		return undefined;
	}
	const url = favoriteUrl(tab.url);
	if (!url) {
		refuse(vscode.l10n.t('Only http and https pages can be saved as favorites.'));
		return undefined;
	}
	return { url, title: pageTitle(tab.title, tab.url) };
}

/** Adds the page a user command is about, asking for its name. Shared by the command and the chat. */
export async function addCurrentPage(browser: BrowserController, ask = true): Promise<string | undefined> {
	if (!store) { return 'Favorites are not available.'; }
	const page = currentPage(browser);
	if (!page) { return 'Open an http or https page in a browser tab first.'; }
	const existing = store.findUrl(page.url);
	if (existing) {
		const message = vscode.l10n.t('Already in favorites as "{0}".', plainInLabel(existing.title));
		refuse(message);
		return message;
	}
	let title: string | undefined = page.title;
	if (ask) {
		title = await vscode.window.showInputBox({
			title: vscode.l10n.t('Add to Favorites'),
			prompt: plainInLabel(page.url, 200),
			value: page.title,
			ignoreFocusOut: true,
			validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a name for the favorite'),
		});
		if (title === undefined) { return 'Cancelled.'; }
	}
	const error = await store.add(page.url, title);
	if (error) { refuse(error); } else { confirm(vscode.l10n.t('Added to favorites: {0}', plainInLabel(title || page.url))); }
	return error;
}

/** Opens a favorite; for Chrome, resolves to the tab it opened (the chat pins it). */
export async function openFavoriteSite(site: FavoriteSite, where: 'vscode' | 'chrome'): Promise<vscode.BrowserTab | undefined> {
	if (where === 'chrome') { return vscode.commands.executeCommand<vscode.BrowserTab | undefined>('hoverdeck.openInChrome', site.url); }
	await vscode.commands.executeCommand('hoverdeck.show', site.url);
	return undefined;
}

interface FavoriteItem extends vscode.QuickPickItem {
	readonly site: FavoriteSite;
}

async function pickFavorite(): Promise<void> {
	const sites = store?.list() ?? [];
	if (!sites.length) {
		refuse(vscode.l10n.t('No favorites yet: use Add to Favorites… on a page.'));
		return;
	}
	const chromeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('globe'), tooltip: vscode.l10n.t('Open in Google Chrome') };
	const removeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Remove from favorites') };
	const pick = vscode.window.createQuickPick<FavoriteItem>();
	const fill = () => {
		pick.items = (store?.list() ?? []).map(site => ({
			label: plainInLabel(site.title),
			description: plainInLabel(site.url, 200),
			buttons: [chromeButton, removeButton],
			site,
		}));
	};
	fill();
	pick.title = vscode.l10n.t('Open Favorite');
	pick.placeholder = vscode.l10n.t('Enter opens in VS Code; the globe opens in Google Chrome');
	pick.matchOnDescription = true;
	const done = new Promise<void>(resolve => {
		pick.onDidAccept(() => {
			const site = pick.selectedItems[0]?.site;
			pick.hide();
			if (site) { void openFavoriteSite(site, 'vscode'); }
		});
		pick.onDidTriggerItemButton(async ({ item, button }) => {
			if (button === chromeButton) {
				pick.hide();
				void openFavoriteSite(item.site, 'chrome');
				return;
			}
			const error = await store?.edit({ kind: 'remove', id: item.site.id });
			if (error) { refuse(error); }
			fill();
			if (!pick.items.length) { pick.hide(); }
		});
		pick.onDidHide(() => { pick.dispose(); resolve(); });
	});
	pick.show();
	await done;
}

/** The page the star is about: the browser tab in front. */
function starredTab(browser: BrowserController): vscode.BrowserTab | undefined {
	try { return browser.focusedTab ?? browser.userTab; } catch { return undefined; }
}

/** The star's filled form: removes the page in front from favorites. */
async function unstarCurrentPage(browser: BrowserController): Promise<void> {
	const tab = starredTab(browser);
	const url = tab ? favoriteUrl(tab.url) : undefined;
	const site = url ? store?.findUrl(url) : undefined;
	if (!site) { refuse(vscode.l10n.t('This page is not in favorites.')); return; }
	const error = await store?.edit({ kind: 'remove', id: site.id });
	if (error) { refuse(error); } else { confirm(vscode.l10n.t('Removed from favorites: {0}', plainInLabel(site.title))); }
}

export function registerFavorites(context: vscode.ExtensionContext, browser: BrowserController): FavoriteSites {
	store = new FavoriteSites(context.globalState);
	context.subscriptions.push(store, { dispose: () => { store = undefined; } });
	const publish = () => {
		const tab = starredTab(browser);
		const url = tab ? favoriteUrl(tab.url) : undefined;
		void vscode.commands.executeCommand('setContext', pageIsFavoriteKey, !!(url && store?.findUrl(url)));
	};
	context.subscriptions.push(store.onDidChange(publish));
	try {
		context.subscriptions.push(
			vscode.window.onDidChangeActiveBrowserTab(publish),
			vscode.window.onDidChangeBrowserTabState(publish),
		);
	} catch { /* no grant: no browser tab to star */ }
	publish();
	context.subscriptions.push(
		vscode.commands.registerCommand('hoverdeck.favorites.add', () => addCurrentPage(browser)),
		vscode.commands.registerCommand('hoverdeck.favorites.open', () => pickFavorite()),
		// The star adds at once, named by the page's title (renamed in Chat Settings → Favorites).
		vscode.commands.registerCommand('hoverdeck.favorites.star', async () => { await addCurrentPage(browser, false); publish(); }),
		vscode.commands.registerCommand('hoverdeck.favorites.unstar', async () => { await unstarCurrentPage(browser); publish(); }),
		vscode.commands.registerCommand('hoverdeck.favorites.manage', async () => {
			if (openManager && await openManager()) { return; }
			await pickFavorite();
		}),
	);
	return store;
}
