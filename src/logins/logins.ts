/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { productName } from '../core/flavor';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { loginsFromCsv, loginsToCsv } from './loginCsv';
import type { FillResult } from './loginMessages';
import { setLoginsManager, type LoginOperation, type LoginsAction, type LoginsManager, type LoginsView } from './loginsManager';
import { LoginVault } from './loginVault';
import {
	LoginWatcher, type FrameFields, type OfferCard, type PageFrame, type PasskeyDecision, type PasskeyRequest,
	type SuccessfulSubmit, type SuggestChoice, type WatchedTab, type WatcherHandlers,
} from './loginWatcher';
import { confirm, refuse } from '../core/notify';
import { plainInLabel, plainInNotification } from '../core/notifyText';
import { isBrowserApiGranted } from '../setup/proposedApi';
import { writeFileAtomic } from '../core/safeFiles';
import {
	countConflicts, decideSave, hostOf, matchLogins, mergeVault, newId, originOf, parseVault, passkeysFor,
	putLogin, putPasskey, removeLogin, removePasskey, rpIdMatchesHost, sameUsername, serializeVault,
	setNeverSave, toStandardBase64, type LoginEntry, type PasskeyEntry, type SaveDecision, type Vault,
} from './vaultData';
import { isSealed, seal, SealError, unseal } from './vaultSeal';

/*
 * Saved logins and passkeys: the commands, the list under a sign-in field, the
 * save offer, the pickers.
 *
 * HoverDeck draws two things inside a page, and only these: the list of saved
 * logins under a focused sign-in field (`loginSuggestScript.ts`) and the card
 * that offers to save a password after a sign-in that worked. Both live in a
 * closed shadow root in the logins' isolated world, carry usernames and titles
 * only — a password never enters the page until a pick is filled — and answer
 * by ids and tokens the host minted. There is no status bar item: with AI
 * Browser installed beside it, two key items in one status bar was the noise
 * the split had to remove.
 *
 * Confirmations are never notifications, for the reason recorded at length in
 * `notify.ts`: a toast pauses the very page the user is signing in to. The
 * notifications that remain are failures the user has to act on — a file that
 * could not be written, a passkey that could not be stored, a vault that was
 * lost — and the last of those waits until no browser page is in front.
 */

const fillCommand = 'hoverdeck.logins.fill';
const saveFromPageCommand = 'hoverdeck.logins.saveFromPage';
const manageCommand = 'hoverdeck.logins.manage';
const importCommand = 'hoverdeck.logins.import';
const exportCommand = 'hoverdeck.logins.export';

/** How long an unanswered save offer stays. The password is held in memory until then, and no longer. */
const offerLifetimeMs = 5 * 60_000;

/** How long a copied password stays on the clipboard. */
const clipboardClearMs = 45_000;

/** `lastUsed` is not rewritten more often than this, so a busy sign-in page does not rewrite the vault. */
const usageGranularityMs = 60_000;

interface LoginSettings {
	readonly enabled: boolean;
	readonly offerToSave: boolean;
	readonly suggest: boolean;
	readonly autofill: boolean;
	readonly passkeys: boolean;
}

function settings(): LoginSettings {
	const config = vscode.workspace.getConfiguration('hoverdeck');
	return {
		enabled: config.get<boolean>('logins.enabled', true),
		offerToSave: config.get<boolean>('logins.offerToSave', true),
		suggest: config.get<boolean>('logins.showSuggestions', true),
		autofill: config.get<boolean>('logins.autofillOnPageLoad', false),
		passkeys: config.get<boolean>('passkeys.enabled', true),
	};
}

interface Offer {
	readonly submit: SuccessfulSubmit;
	/** The tab the sign-in happened in: its page shows the card. */
	readonly browserTab: vscode.BrowserTab;
	/** Names this offer to the card's buttons; an answer naming another is ignored. */
	readonly token: string;
	readonly decision: Exclude<SaveDecision, { kind: 'none' }>;
	readonly timer: ReturnType<typeof setTimeout>;
	/** When the sign-in was judged a success: the watcher can take that back for a while after. */
	readonly at: number;
	/** The watcher took it back: the site drew a password form again. Nothing may be saved from it. */
	withdrawn?: boolean;
}

/**
 * How long after a sign-in an accepted offer can still be undone because the
 * sign-in turned out to have failed. A little longer than the watcher's own
 * withdrawal window, which starts at the same moment.
 */
const revertWindowMs = 20_000;

interface Item<T> extends vscode.QuickPickItem {
	readonly value?: T;
}

const separator = <T>(label: string): Item<T> => ({ label, kind: vscode.QuickPickItemKind.Separator });

const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

/**
 * Text for a notification body that came from somewhere other than this file —
 * a path the user picked, an error a file system or an import produced. A
 * notification renders links that run commands (breaks-silently #124), and a
 * file name can be `[x](command:…)` as easily as an export can.
 */
const inBody = (value: string) => plainInNotification(value, 240);

/** The day a timestamp falls on, in the user's locale. */
const day = (ms: number) => new Date(ms).toLocaleDateString();

const shownUsername = (username: string) => username ? plainInLabel(username) : vscode.l10n.t("(no username)");

/**
 * Starts saved logins. `openManager` is set once the chat exists: Manage then
 * opens Chat Settings → Logins, and falls back to the QuickPick where the chat
 * cannot open.
 */
export function registerLogins(context: vscode.ExtensionContext): { setManagerOpener(open: () => Promise<boolean>): void } {
	const feature = new LoginsFeature(context);
	context.subscriptions.push(feature);
	setLoginsManager(feature.manager);
	context.subscriptions.push({ dispose: () => setLoginsManager(undefined) });
	return { setManagerOpener: open => { feature.openManager = open; } };
}

/** Each manager switch and the setting it writes. All five are `application`-scoped. */
const settingIds: Record<keyof LoginsView['settings'], string> = {
	enabled: 'logins.enabled',
	offerToSave: 'logins.offerToSave',
	showSuggestions: 'logins.showSuggestions',
	autofillOnPageLoad: 'logins.autofillOnPageLoad',
	passkeys: 'passkeys.enabled',
};

class LoginsFeature implements WatcherHandlers, vscode.Disposable {

	private readonly _vault: LoginVault;
	private readonly _watcher: LoginWatcher;
	private readonly _disposables: vscode.Disposable[] = [];
	private _offer: Offer | undefined;
	/**
	 * What each list under a field stands for: per watched tab and frame
	 * context, the ids handed to the page and the saved login each names. Ids
	 * are minted afresh with every push, so one from an older list finds nothing.
	 */
	private readonly _choices = new WeakMap<WatchedTab, Map<number, Map<string, string>>>();
	/** Offers made recently, open picker or not: a withdrawal reaches all of them. */
	private readonly _recentOffers = new Set<Offer>();
	/** The last change an offer made, and how to undo it if its sign-in is withdrawn. */
	private _lastCommit: { readonly origin: string; readonly until: number; readonly undo: (vault: Vault) => Vault | undefined } | undefined;
	/** The vault was found lost and the user has not been told yet: a toast waits for no browser page to be in front. */
	private _lossPending = false;
	/** Opens Chat Settings → Logins; false where the chat cannot open. */
	public openManager: (() => Promise<boolean>) | undefined;

	/** What Chat Settings → Logins reads and asks for. No password in either direction. */
	public readonly manager: LoginsManager = {
		view: () => this._managerView(),
		act: action => this._managerAct(action),
		onDidChange: listener => {
			const subs = [
				this._vault.onDidChange(listener),
				vscode.workspace.onDidChangeConfiguration(e => {
					if (e.affectsConfiguration('hoverdeck.logins') || e.affectsConfiguration('hoverdeck.passkeys')) { listener(); }
				}),
			];
			return { dispose: () => subs.forEach(sub => sub.dispose()) };
		},
	};

	constructor(context: vscode.ExtensionContext) {
		this._vault = new LoginVault(context.secrets, context.globalStorageUri, context.globalState);
		this._watcher = new LoginWatcher(this, () => settings());
		this._disposables.push(this._vault, this._watcher);

		const register = (id: string, run: (...args: any[]) => unknown) =>
			this._disposables.push(vscode.commands.registerCommand(id, run));
		register(fillCommand, () => this._fill());
		register(saveFromPageCommand, () => this._saveFromPage());
		register(manageCommand, () => this._manage());
		register(importCommand, () => this._import());
		register(exportCommand, () => this._export());

		this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('hoverdeck.logins.enabled') || e.affectsConfiguration('hoverdeck.passkeys.enabled')) {
				if (!settings().enabled) {
					this._clearOffer();
				}
				this._watcher.restart();
			}
			if (e.affectsConfiguration('hoverdeck.logins.offerToSave') && !settings().offerToSave) {
				// Switched off with an offer up: the offer goes too, rather than
				// staying for its five minutes against the setting.
				this._clearOffer();
			}
			if (e.affectsConfiguration('hoverdeck.logins')) {
				void this._refreshSuggestions();
			}
		}));
		this._disposables.push(this._vault.onDidChange(() => void this._refreshSuggestions()));
		this._disposables.push(this._vault.onDidLose(() => {
			this._lossPending = true;
			this._reportLoss();
		}));
		if (isBrowserApiGranted()) {
			// A lost vault is reported once no browser page is in front, and
			// switching the visible tab of a group is a tab change, not a group
			// change (breaks-silently #128).
			this._disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => this._reportLoss()));
			this._disposables.push(vscode.window.tabGroups.onDidChangeTabGroups(() => this._reportLoss()));
		}
		this._watcher.start();
	}

	// --- the list under a field, and the offer card -----------------------

	/**
	 * Pushes the saved logins for `frame` into the list under its fields — or
	 * takes the list away. Usernames and titles go into the page; a pick comes
	 * back as an id that is looked up here.
	 */
	private async _suggest(tab: WatchedTab, frame: FrameFields, vault?: Vault): Promise<void> {
		const config = settings();
		let choices: SuggestChoice[] = [];
		const ids = new Map<string, string>();
		if (config.enabled && config.suggest && (frame.login || frame.usernameOnly)) {
			try {
				vault ??= await this._vault.read();
			} catch {
				vault = undefined;
			}
			for (const match of vault ? matchLogins(vault, frame.origin) : []) {
				const id = randomBytes(9).toString('base64url');
				ids.set(id, match.entry.id);
				choices.push({
					id,
					username: match.entry.username || vscode.l10n.t("(no username)"),
					detail: match.kind === 'sameHost' ? match.entry.origin : match.entry.title ?? '',
				});
			}
			choices = choices.slice(0, 20);
		}
		let frames = this._choices.get(tab);
		if (!frames) {
			frames = new Map();
			this._choices.set(tab, frames);
		}
		frames.set(frame.contextId, ids);
		await tab.suggest(frame, choices, {
			title: vscode.l10n.t("Saved logins for {0}", hostOf(frame.origin) ?? frame.origin),
			other: vault && vault.logins.length > choices.length ? vscode.l10n.t("Use a login saved for another site…") : '',
			manage: vscode.l10n.t("Manage saved logins…"),
		}).catch(() => undefined);
	}

	/** Every list on every watched page again: the vault or the settings changed. */
	private async _refreshSuggestions(): Promise<void> {
		let vault: Vault | undefined;
		try {
			vault = await this._vault.read();
		} catch {
			vault = undefined;
		}
		for (const tab of await this._watcher.watched()) {
			for (const frame of tab.frames) {
				await this._suggest(tab, frame, vault);
			}
		}
	}

	/** The card for `offer`, as the page shows it. Text only. */
	private _card(offer: Offer): OfferCard {
		const { submit, decision } = offer;
		const site = hostOf(submit.origin) ?? submit.origin;
		return {
			token: offer.token,
			kind: decision.kind,
			title: decision.kind === 'save'
				? vscode.l10n.t("Save the password for {0}?", site)
				: vscode.l10n.t("Update the saved password for {0}?", site),
			who: (decision.kind === 'save' ? submit.username : decision.entry.username) || vscode.l10n.t("(no username)"),
			primary: decision.kind === 'save' ? vscode.l10n.t("Save") : vscode.l10n.t("Update"),
			later: vscode.l10n.t("Not now"),
			never: vscode.l10n.t("Never"),
			neverTitle: vscode.l10n.t("Never for this site"),
			more: vscode.l10n.t("More options"),
			close: vscode.l10n.t("Close"),
		};
	}

	/** Shows or takes down the card on the offer's tab, if that tab is watched. */
	private async _showCard(offer: Offer, show: boolean): Promise<void> {
		const watched = await this._watcher.existing(offer.browserTab);
		await watched?.offer(show ? this._card(offer) : undefined).catch(() => undefined);
	}

	private _setOffer(offer: Omit<Offer, 'timer' | 'at' | 'token'>): void {
		this._clearOffer();
		const timer = setTimeout(() => {
			if (this._offer?.timer === timer) {
				this._clearOffer();
			}
		}, offerLifetimeMs);
		const made: Offer = { ...offer, timer, at: Date.now(), token: randomBytes(12).toString('base64url') };
		this._offer = made;
		this._recentOffers.add(made);
		setTimeout(() => this._recentOffers.delete(made), revertWindowMs).unref?.();
		void this._showCard(made, true);
	}

	/**
	 * Tells the user their saved logins were lost — once, and not over a
	 * browser page, which a toast would pause (#10). Until then the status bar
	 * says it.
	 */
	private _reportLoss(): void {
		if (!this._lossPending) {
			return;
		}
		if (this._watcher.tabInFront()) {
			refuse(vscode.l10n.t("{0}'s saved logins could not be read and are gone — see the message once you leave the browser tab.", productName()));
			return;
		}
		this._lossPending = false;
		void vscode.window.showWarningMessage(process.platform === 'linux'
			? vscode.l10n.t("{0}'s saved logins are gone. VS Code could not decrypt its secret storage — the keyring changed — or no keyring is available, in which case VS Code keeps secrets in memory only, per window, until that window closes. An encrypted export, if you made one, can be imported again.", productName())
			: vscode.l10n.t("{0}'s saved logins are gone: VS Code could not decrypt its secret storage — the system keychain changed — and discarded them. An encrypted export, if you made one, can be imported again.", productName()));
	}

	private _clearOffer(): void {
		const offer = this._offer;
		if (offer) {
			clearTimeout(offer.timer);
			this._offer = undefined;
			void this._showCard(offer, false);
		}
	}

	// --- reading the vault, reporting failures --------------------------------

	private async _read(): Promise<Vault | undefined> {
		try {
			return await this._vault.read();
		} catch (err) {
			// A refusal, not a toast: a sign-in page is very likely on screen.
			refuse(errorText(err));
			return undefined;
		}
	}

	private async _write<T>(change: (vault: Vault) => { vault: Vault; result: T } | undefined): Promise<T | undefined> {
		try {
			return await this._vault.update(change);
		} catch (err) {
			refuse(vscode.l10n.t("Saved logins were not changed: {0}", errorText(err)));
			return undefined;
		}
	}

	private _markUsed(id: string): void {
		const now = Date.now();
		void this._write(vault => {
			const entry = vault.logins.find(e => e.id === id);
			if (!entry || (entry.lastUsed && now - entry.lastUsed < usageGranularityMs)) {
				return undefined;
			}
			return { vault: putLogin(vault, { ...entry, lastUsed: now }), result: true };
		});
	}

	/** The browser tab the user means, with the watcher on it, or a refusal saying which half is missing. */
	private async _focusedPage(): Promise<WatchedTab | undefined> {
		if (!settings().enabled) {
			refuse(vscode.l10n.t("Saved logins are turned off — see the setting hoverdeck.logins.enabled."));
			return undefined;
		}
		if (!isBrowserApiGranted()) {
			refuse(vscode.l10n.t("Browser API not enabled — run \"{0}: Enable Integrated Browser API\" from the command palette.", productName()));
			return undefined;
		}
		// Not `activeBrowserTab`: see `LoginWatcher.userTab` for the bug that was.
		const found = this._watcher.userTab();
		if (!found) {
			refuse((vscode.window.browserTabs ?? []).length === 0
				? vscode.l10n.t("No integrated browser tab is open.")
				: vscode.l10n.t("Several browser tabs are open — click into the page you want to sign in to, then try again."));
			return undefined;
		}
		const watched = await this._watcher.ensure(found.tab);
		if (!watched) {
			refuse(vscode.l10n.t("Could not attach to this browser tab."));
			return undefined;
		}
		if (!watched.pageOrigin) {
			refuse(vscode.l10n.t("Logins are saved for http and https pages only."));
			return undefined;
		}
		return watched;
	}

	// --- filling ------------------------------------------------------------

	private async _fill(): Promise<void> {
		const watched = await this._focusedPage();
		const vault = watched && await this._read();
		if (!watched || !vault) {
			return;
		}
		const page = watched.pageOrigin!;
		const matches = matchLogins(vault, page);

		type Choice = { kind: 'login'; entry: LoginEntry } | { kind: 'other' } | { kind: 'save' } | { kind: 'manage' };
		const items: Item<Choice>[] = [];
		if (matches.length === 0) {
			items.push(separator(vscode.l10n.t("Nothing saved for {0}", plainInLabel(page))));
		}
		for (const match of matches) {
			items.push({
				label: `$(account) ${shownUsername(match.entry.username)}`,
				description: match.kind === 'sameHost' ? plainInLabel(match.entry.origin) : plainInLabel(match.entry.title ?? ''),
				detail: match.entry.lastUsed
					? vscode.l10n.t("Last used {0}", day(match.entry.lastUsed))
					: vscode.l10n.t("Saved {0}", day(match.entry.updated)),
				value: { kind: 'login', entry: match.entry },
			});
		}
		items.push(separator(''));
		if (vault.logins.length > matches.length) {
			items.push({ label: vscode.l10n.t("$(search) Use a login saved for another site…"), value: { kind: 'other' } });
		}
		items.push({ label: vscode.l10n.t("$(add) Save the login on this page…"), value: { kind: 'save' } });
		items.push({ label: vscode.l10n.t("$(gear) Manage saved logins and passkeys…"), value: { kind: 'manage' } });

		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("Fill a login on {0}", plainInLabel(page)),
			placeHolder: vscode.l10n.t("Pick a login"),
			matchOnDescription: true,
		});
		const choice = picked?.value;
		if (!choice) {
			return;
		}
		if (choice.kind === 'save') {
			return this._saveFromPage();
		}
		if (choice.kind === 'manage') {
			return this._manage();
		}
		let entry: LoginEntry;
		if (choice.kind === 'other') {
			const other = await this._pickOtherSite(vault, page);
			if (!other) {
				return;
			}
			entry = other;
		} else {
			entry = choice.entry;
		}
		await this._fillInto(watched, entry, page);
	}

	/**
	 * Every login, for a deliberate fill into a site it was not saved for — the
	 * same account behind `app.example.com` and `auth.example.com`, say.
	 *
	 * This is the one path that crosses origins, so it asks first, naming both
	 * sites: an address that only resembles the saved one is exactly how a
	 * phishing page gets a password, and the modal is the one moment the user
	 * reads both side by side. A modal is a decision, which is what a dialog
	 * over the page is allowed to be (see `notify.ts`).
	 */
	private async _pickOtherSite(vault: Vault, page: string): Promise<LoginEntry | undefined> {
		const items: Item<LoginEntry>[] = [...vault.logins]
			.sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
			.map(entry => ({
				label: `$(account) ${shownUsername(entry.username)}`,
				description: plainInLabel(entry.origin),
				detail: entry.title ? plainInLabel(entry.title) : undefined,
				value: entry,
			}));
		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("Logins saved for other sites"),
			placeHolder: vscode.l10n.t("Search by site or username"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked?.value) {
			return undefined;
		}
		const fill = vscode.l10n.t("Fill");
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t("Fill the login saved for {0} into {1}?", picked.value.origin, page),
			{ modal: true, detail: vscode.l10n.t("Only do this if both addresses belong to the same service.") },
			fill);
		return answer === fill ? picked.value : undefined;
	}

	private async _fillInto(watched: WatchedTab, entry: LoginEntry, page: string): Promise<void> {
		// Frames of the page's own origin, plus frames of the login's own
		// origin — never a third one. A frame on another origin is another
		// site, whatever page it is embedded in.
		this._reportFill(entry, await watched.fill(entry.username, entry.password, new Set([page, entry.origin])));
	}

	private _reportFill(entry: LoginEntry, result: FillResult): void {
		if (!result.username && !result.password) {
			refuse(result.reason === 'newPasswordOnly'
				? vscode.l10n.t("This looks like a sign-up or password-change form, so nothing was filled.")
				: result.reason === 'tooLong'
					? vscode.l10n.t("The saved login is longer than the page's field allows, so nothing was filled.")
					: vscode.l10n.t("No sign-in fields found on this page."));
			return;
		}
		this._markUsed(entry.id);
		confirm(result.password
			? vscode.l10n.t("Filled {0}", shownUsername(entry.username))
			: vscode.l10n.t("Filled the username {0} — the password goes on the next step", shownUsername(entry.username)));
	}

	// --- saving ---------------------------------------------------------------

	/** A sign-in that went through: offer to save or update, or note the use. */
	public async onSubmitted(tab: WatchedTab, submit: SuccessfulSubmit): Promise<void> {
		const config = settings();
		if (!config.enabled) {
			return;
		}
		const vault = await this._read();
		if (!vault) {
			return;
		}
		const decision = decideSave(vault, submit.origin, submit.username, submit.password, submit.previousPassword, submit.accountUnknown);
		if (decision.kind === 'none') {
			if (decision.reason === 'unchanged') {
				const used = vault.logins.find(e => e.origin === submit.origin && e.password === submit.password
					&& (!submit.username || sameUsername(e.username, submit.username)));
				if (used) {
					this._markUsed(used.id);
				}
			}
			return;
		}
		if (config.offerToSave) {
			this._setOffer({ submit, decision, browserTab: tab.tab });
		}
	}

	/**
	 * The sign-in just offered turned out not to have worked — the site drew its
	 * sign-in form again. The offer goes before anyone can accept it: offering
	 * to save a wrong password is the one mistake this feature must not make.
	 */
	public onSubmitWithdrawn(_tab: WatchedTab, origin: string): void {
		let withdrew = false;
		// Every recent offer for the site, not only the one in the status bar:
		// a picker already open on it would otherwise still save the password
		// the site just rejected.
		for (const offer of this._recentOffers) {
			if (offer.submit.origin === origin && !offer.withdrawn) {
				offer.withdrawn = true;
				withdrew = true;
			}
		}
		if (this._offer?.submit.origin === origin) {
			this._clearOffer();
		}
		const commit = this._lastCommit;
		if (commit && commit.origin === origin && Date.now() < commit.until) {
			// Accepted before the site said no: undone. The user answered an
			// offer that the extension has now learned was wrong.
			this._lastCommit = undefined;
			void this._write(vault => {
				const undone = commit.undo(vault);
				return undone ? { vault: undone, result: true } : undefined;
			}).then(done => {
				if (done) {
					refuse(vscode.l10n.t("The sign-in on {0} did not go through, so the saved login was put back as it was.", plainInLabel(origin)));
				}
			});
			return;
		}
		if (withdrew) {
			refuse(vscode.l10n.t("The sign-in on {0} did not go through, so there is nothing to save.", plainInLabel(origin)));
		}
	}

	/** Refuses to act on an offer the watcher took back, and says why. */
	private _stillValid(offer: Offer): boolean {
		if (offer.withdrawn) {
			refuse(vscode.l10n.t("The sign-in on {0} did not go through, so there is nothing to save.", plainInLabel(offer.submit.origin)));
			return false;
		}
		return true;
	}

	/** Remembers how to undo what an offer just did, while its sign-in can still be withdrawn. */
	private _noteCommit(offer: Offer, undo: (vault: Vault) => Vault | undefined): void {
		// Withdrawn while the write was on its way, or while a "Replace?" modal
		// waited: there was no commit yet for the withdrawal to undo, and it
		// fires once. Undone here, or the rejected password stayed saved.
		if (offer.withdrawn) {
			void this._write(vault => {
				const undone = undo(vault);
				return undone ? { vault: undone, result: true } : undefined;
			}).then(done => {
				if (done) {
					refuse(vscode.l10n.t("The sign-in on {0} did not go through, so the saved login was put back as it was.", plainInLabel(offer.submit.origin)));
				}
			});
			return;
		}
		this._lastCommit = { origin: offer.submit.origin, until: offer.at + revertWindowMs, undo };
	}

	/** A button of the card in the page. `token` must name an offer made lately. */
	public onOfferAnswer(_tab: WatchedTab, token: string, action: 'save' | 'update' | 'later' | 'never' | 'more'): void {
		const offer = this._offer?.token === token ? this._offer : [...this._recentOffers].find(o => o.token === token);
		if (!offer) {
			refuse(vscode.l10n.t("There is nothing to save — the offer has expired."));
			return;
		}
		if ((action === 'save' && offer.decision.kind !== 'save') || (action === 'update' && offer.decision.kind !== 'update')) {
			return;
		}
		void this._answerOffer(offer, action === 'more' ? undefined : action).catch(err => refuse(errorText(err)));
	}

	/** Acts on `offer`: with `given`, the page's answer; without, a picker of every answer. */
	private async _answerOffer(offer: Offer, given?: 'save' | 'update' | 'later' | 'never'): Promise<void> {
		const { submit, decision } = offer;
		type Answer = 'save' | 'update' | 'saveNew' | 'editSave' | 'later' | 'never';
		const items: Item<Answer>[] = [];
		if (decision.kind === 'save') {
			items.push({
				label: vscode.l10n.t("$(check) Save"),
				description: `${shownUsername(submit.username)} · ${plainInLabel(submit.origin)}`,
				value: 'save',
			});
			items.push({ label: vscode.l10n.t("$(edit) Edit the username, then save…"), value: 'editSave' });
		} else {
			items.push({
				label: vscode.l10n.t("$(check) Update the saved password"),
				description: `${shownUsername(decision.entry.username)} · ${plainInLabel(submit.origin)}`,
				value: 'update',
			});
			items.push({ label: vscode.l10n.t("$(add) Save as a separate login…"), value: 'editSave' });
		}
		items.push({ label: vscode.l10n.t("$(close) Not now"), value: 'later' });
		items.push({ label: vscode.l10n.t("$(circle-slash) Never for this site"), description: plainInLabel(submit.origin), value: 'never' });

		const picked: { value?: Answer } | undefined = given ? { value: given } : await vscode.window.showQuickPick(items, {
			title: decision.kind === 'save'
				? vscode.l10n.t("Save the password for {0}?", plainInLabel(submit.origin))
				: vscode.l10n.t("Update the password for {0}?", plainInLabel(submit.origin)),
		});
		if (!picked?.value || !this._stillValid(offer)) {
			return;
		}
		// The answer is about *this* offer, even if a newer one replaced it or it
		// expired while the picker was open: dropping it said nothing and saved
		// nothing, after the user had pressed Save. Only a current offer is
		// taken down. A *withdrawn* one is another matter — see `_stillValid`.
		const settle = () => {
			if (this._offer === offer) {
				this._clearOffer();
			}
		};
		const now = Date.now();
		switch (picked.value) {
			case 'later':
				settle();
				return;
			case 'never': {
				settle();
				const done = await this._write(vault => ({ vault: setNeverSave(vault, submit.origin, true), result: true }));
				// Only once it is stored: confirming after a failed write put a
				// success line over the refusal, about a setting that was never saved.
				if (done) {
					confirm(vscode.l10n.t("{1} will not offer to save logins on {0}", plainInLabel(submit.origin), productName()));
				}
				return;
			}
			case 'update': {
				if (decision.kind !== 'update') {
					return;
				}
				settle();
				let previous: LoginEntry | undefined;
				let missing = false;
				const done = await this._write(vault => {
					const entry = vault.logins.find(e => e.id === decision.entry.id);
					if (!entry) {
						missing = true;
						return undefined;
					}
					previous = entry;
					return { vault: putLogin(vault, { ...entry, password: submit.password, updated: now, lastUsed: now }), result: true };
				});
				if (done === true && previous) {
					const before = previous;
					this._noteCommit(offer, vault => {
						const entry = vault.logins.find(e => e.id === before.id);
						return entry && entry.password === submit.password ? putLogin(vault, before) : undefined;
					});
					// Withdrawn while the write was on its way: `_noteCommit` has just
					// put it back and said so, and a success line here would claim
					// the opposite a moment before.
					if (!offer.withdrawn) {
						confirm(vscode.l10n.t("Updated the password of {0}", shownUsername(decision.entry.username)));
					}
				} else if (missing) {
					refuse(vscode.l10n.t("That login was deleted in the meantime, so nothing was updated."));
				}
				return;
			}
			case 'save':
			case 'editSave': {
				let username = submit.username;
				if (picked.value === 'editSave') {
					const edited = await vscode.window.showInputBox({
						title: vscode.l10n.t("Username for {0}", plainInLabel(submit.origin)),
						value: username,
						ignoreFocusOut: true,
					});
					if (edited === undefined || !this._stillValid(offer)) {
						return;
					}
					username = edited.trim();
				}
				settle();
				const saved = await this._saveNew(submit.origin, username, submit.password, now, offer);
				if (saved) {
					this._noteCommit(offer, vault => {
						const entry = vault.logins.find(e => e.id === saved.after.id);
						if (!entry || entry.password !== submit.password) {
							return undefined;
						}
						return saved.before ? putLogin(vault, saved.before) : removeLogin(vault, entry.id);
					});
				}
				return;
			}
		}
	}

	/**
	 * Saves a login as new — and never replaces a saved password without saying so.
	 *
	 * A login is one origin and one username, so "save" for a username already
	 * saved can only mean "replace its password". That used to happen silently:
	 * "Save as a separate login…" with the prefilled username updated the very
	 * login the user had just declined to update, and "Save Login from Page"
	 * overwrote a saved password with whatever the field held. Replacing is
	 * now a question with its own answer.
	 */
	private async _saveNew(origin: string, username: string, password: string, now: number, offer?: Offer)
		: Promise<{ readonly before?: LoginEntry; readonly after: LoginEntry } | undefined> {
		const vault = await this._read();
		if (!vault) {
			return undefined;
		}
		// What is saved under this name, as far as this window knows — and what
		// the user agreed to replace. **The check is repeated under the lock**:
		// another window can save the same account between the question and the
		// write, and the write used to replace that one without asking.
		let known = vault.logins.find(e => e.origin === origin && sameUsername(e.username, username));
		let agreed: { readonly id: string; readonly password: string } | undefined;
		const agreedTo = (entry: LoginEntry) => agreed !== undefined && agreed.id === entry.id && agreed.password === entry.password;
		for (let round = 0; round < 3; round++) {
			if (known && known.password === password) {
				this._markUsed(known.id);
				confirm(vscode.l10n.t("{0} is already saved with this password", shownUsername(known.username)));
				return undefined;
			}
			if (known && !agreedTo(known)) {
				const replace = vscode.l10n.t("Replace");
				const answer = await vscode.window.showWarningMessage(
					vscode.l10n.t("A login for {0} on {1} is already saved. Replace its password?",
						known.username || vscode.l10n.t("(no username)"), origin),
					{ modal: true }, replace);
				if (answer !== replace) {
					return undefined;
				}
				// The modal can stay up while the site draws its form again: an
				// answer to an offer withdrawn meanwhile writes nothing.
				if (offer && !this._stillValid(offer)) {
					return undefined;
				}
				agreed = { id: known.id, password: known.password };
			}
			let conflict: LoginEntry | undefined;
			let before: LoginEntry | undefined;
			let after: LoginEntry | undefined;
			const done = await this._write(current => {
				const same = current.logins.find(e => e.origin === origin && sameUsername(e.username, username));
				if (same && same.password !== password && !agreedTo(same)) {
					conflict = same;
					return undefined;
				}
				before = same;
				after = same
					? { ...same, password, updated: now, lastUsed: now }
					: { id: newId(), origin, username, password, created: now, updated: now, lastUsed: now };
				return { vault: setNeverSave(putLogin(current, after), origin, false), result: same ? 'updated' : 'saved' };
			});
			if (conflict) {
				known = conflict;
				continue;
			}
			// Not for an offer withdrawn meanwhile: the caller's `_noteCommit` puts
			// the write back and says so.
			if (done === 'saved' && !offer?.withdrawn) {
				confirm(vscode.l10n.t("Saved the login {0} for {1}", shownUsername(username), plainInLabel(origin)));
			} else if (done === 'updated' && !offer?.withdrawn) {
				confirm(vscode.l10n.t("Updated the password of {0}", shownUsername(username)));
			}
			return done && after ? { before, after } : undefined;
		}
		refuse(vscode.l10n.t("The saved logins kept changing in another window — try again."));
		return undefined;
	}

	/**
	 * Saves what the page's fields hold right now.
	 *
	 * The manual route, for the forms the submit detection cannot see — and for
	 * saving before signing in at all. It ignores the never-save list, since
	 * asking is the user's own decision.
	 */
	private async _saveFromPage(): Promise<void> {
		const watched = await this._focusedPage();
		if (!watched) {
			return;
		}
		const found = await watched.read(new Set([watched.pageOrigin!]));
		if (!found) {
			refuse(vscode.l10n.t("No filled-in password field found on this page."));
			return;
		}
		const { origin, login } = found;
		const password = login.newPassword || login.password;
		const username = await vscode.window.showInputBox({
			title: vscode.l10n.t("Save the login for {0}", plainInLabel(origin)),
			prompt: vscode.l10n.t("Username — leave empty for a password-only login"),
			value: login.username,
			ignoreFocusOut: true,
		});
		if (username === undefined) {
			return;
		}
		await this._saveNew(origin, username.trim(), password, Date.now());
	}

	// --- autofill and suggestions ---------------------------------------------

	public async onFields(tab: WatchedTab, frame: FrameFields): Promise<void> {
		void this._suggest(tab, frame);
		// A sign-in that navigated: the card was in the page that went. The
		// new document's settled report puts it back while the offer stands.
		const offer = this._offer;
		if (offer && frame.settled && offer.browserTab === tab.tab && frame.origin === tab.pageOrigin) {
			void this._showCard(offer, true);
		}
		const config = settings();
		if (!config.enabled || !config.autofill || !frame.login || tab.autofilled.has(frame.contextId)
			|| frame.origin !== tab.pageOrigin) {
			return;
		}
		tab.autofilled.add(frame.contextId);
		let vault: Vault;
		try {
			vault = await this._vault.read();
		} catch {
			return;
		}
		// On load, only an exact origin and only one candidate: anything that
		// needs a choice is the user's to make, and a page that only resembles
		// the saved one gets nothing it did not ask for.
		const exact = matchLogins(vault, frame.origin).filter(match => match.kind === 'exact');
		if (exact.length !== 1) {
			return;
		}
		const entry = exact[0].entry;
		const result = await tab.fill(entry.username, entry.password, new Set([frame.origin]), true);
		if (result.password || result.username) {
			this._markUsed(entry.id);
			confirm(vscode.l10n.t("Filled {0}", shownUsername(entry.username)));
		}
	}

	/** A saved login picked in the list under a field: filled into that frame only. */
	public async onSuggestPick(tab: WatchedTab, frame: PageFrame, id: string): Promise<void> {
		const entryId = this._choices.get(tab)?.get(frame.contextId)?.get(id);
		const vault = entryId ? await this._read() : undefined;
		const entry = vault?.logins.find(e => e.id === entryId);
		if (!entry) {
			refuse(vscode.l10n.t("That login is no longer saved."));
			return;
		}
		// The list offered it for this frame's origin: its own, or the same host
		// on another port or scheme — the frame's origin and the login's own.
		this._reportFill(entry, await tab.fillFrame(frame, entry.username, entry.password, new Set([frame.origin, entry.origin])));
	}

	/** A footer row of the list. */
	public async onSuggestAction(tab: WatchedTab, frame: PageFrame, action: 'other' | 'manage'): Promise<void> {
		if (action === 'manage') {
			await vscode.commands.executeCommand(manageCommand);
			return;
		}
		const vault = await this._read();
		const entry = vault && await this._pickOtherSite(vault, frame.origin);
		if (entry) {
			this._reportFill(entry, await tab.fillFrame(frame, entry.username, entry.password, new Set([frame.origin, entry.origin])));
		}
	}

	// --- passkeys -------------------------------------------------------------

	public async onPasskeyRequest(tab: WatchedTab, request: PasskeyRequest, token: vscode.CancellationToken): Promise<PasskeyDecision> {
		// Only the page in front of the user may ask. A background tab putting a
		// picker up is a question about a page nobody is looking at.
		if (!isBrowserApiGranted() || this._watcher.tabInFront() !== tab.tab) {
			return { kind: 'deny' };
		}
		// The browser checks this again; this copy is so that a page can never
		// get another site's passkey *offered* under its own name.
		const host = hostOf(request.origin);
		if (!host || !rpIdMatchesHost(request.rpId, host)) {
			return { kind: 'deny' };
		}
		const vault = await this._read();
		if (!vault) {
			return { kind: 'deny' };
		}
		type Choice = { kind: 'use'; passkey: PasskeyEntry } | { kind: 'save' | 'native' | 'deny' };

		if (request.op === 'get') {
			const keys = passkeysFor(vault, request.rpId, request.allow);
			if (keys.length === 0) {
				// Nothing of ours: the request goes to the browser's own
				// authenticators, which is what it would have met without us.
				refuse(vscode.l10n.t("No passkey for {0} is saved in {1}.", plainInLabel(request.rpId), productName()));
				return { kind: 'native' };
			}
			const items: Item<Choice>[] = keys.map(passkey => ({
				label: `$(key) ${plainInLabel(passkey.userName || passkey.userDisplayName || vscode.l10n.t("(unnamed)"))}`,
				description: passkey.userDisplayName && passkey.userDisplayName !== passkey.userName
					? plainInLabel(passkey.userDisplayName) : undefined,
				detail: passkey.lastUsed
					? vscode.l10n.t("Last used {0}", day(passkey.lastUsed))
					: vscode.l10n.t("Saved {0}", day(passkey.created)),
				value: { kind: 'use', passkey },
			}));
			items.push(separator(''));
			items.push({ label: vscode.l10n.t("$(device-mobile) Use a security key or another device"), value: { kind: 'native' } });
			items.push({ label: vscode.l10n.t("$(close) Cancel"), value: { kind: 'deny' } });
			const choice = await pickWithCancellation(items, {
				title: vscode.l10n.t("Sign in to {0} with a passkey", plainInLabel(request.rpId)),
				placeHolder: vscode.l10n.t("Pick the account to sign in with"),
			}, token);
			return choice ?? { kind: 'deny' };
		}

		// A passkey for this account may already be here. That is decided only
		// *after* the user answers the same question as for any other account:
		// answered at once — "already registered", or a refusal in milliseconds
		// instead of a picker that waits — it let a site test which of its
		// credential ids this browser holds, and recognise a signed-out user.
		const exclude = new Set((request.exclude ?? []).map(toStandardBase64));
		const alreadySaved = vault.passkeys.some(p => p.rpId === request.rpId && exclude.has(toStandardBase64(p.credentialId)));
		const account = request.userName || request.userDisplayName || '';
		const choice = await pickWithCancellation<Choice>([
			{
				label: vscode.l10n.t("$(key) Save the passkey in {0}", productName()),
				detail: vscode.l10n.t("Kept in VS Code's secret storage, encrypted by the operating system"),
				value: { kind: 'save' },
			},
			{ label: vscode.l10n.t("$(device-mobile) Use a security key or another device"), value: { kind: 'native' } },
			{ label: vscode.l10n.t("$(close) Cancel"), value: { kind: 'deny' } },
		], {
			title: vscode.l10n.t("Create a passkey for {0}", plainInLabel(request.rpId)),
			placeHolder: account
				? vscode.l10n.t("Account: {0}", plainInLabel(account))
				: vscode.l10n.t("The site is asking to create a passkey"),
		}, token);
		if (choice?.kind === 'save' && alreadySaved) {
			refuse(vscode.l10n.t("A passkey for this account on {0} is already saved.", plainInLabel(request.rpId)));
			return { kind: 'deny' };
		}
		return choice ?? { kind: 'deny' };
	}

	public async onPasskeyCreated(_tab: WatchedTab, request: PasskeyRequest, credential: any): Promise<void> {
		const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
		const credentialId = str(credential?.credentialId);
		const privateKey = str(credential?.privateKey);
		if (!credentialId || !privateKey) {
			refuse(vscode.l10n.t("The browser did not hand over the new passkey, so it was not saved."));
			return;
		}
		const now = Date.now();
		const userName = str(credential.userName) ?? request.userName;
		const userDisplayName = str(credential.userDisplayName) ?? request.userDisplayName;
		const userHandle = str(credential.userHandle);
		const entry: PasskeyEntry = {
			id: newId(),
			rpId: request.rpId,
			credentialId,
			privateKey,
			signCount: typeof credential.signCount === 'number' ? credential.signCount : 0,
			origin: request.origin,
			created: now,
			...(userHandle ? { userHandle } : {}),
			...(userName ? { userName } : {}),
			...(userDisplayName ? { userDisplayName } : {}),
		};
		const done = await this._write(vault => ({ vault: putPasskey(vault, entry), result: true }));
		if (done) {
			confirm(vscode.l10n.t("Saved a passkey for {0}", plainInLabel(request.rpId)));
		} else {
			// The site already holds the public key, so a passkey that did not
			// reach the vault is one the user cannot sign in with again.
			void vscode.window.showErrorMessage(vscode.l10n.t(
				"The passkey the site just registered for {0} could not be saved. Remove it in that site's security settings and create it again.",
				plainInNotification(request.rpId)));
		}
	}

	public onPasskeyUsed(_tab: WatchedTab, passkey: PasskeyEntry, signCount: number): void {
		const now = Date.now();
		void this._write(vault => {
			const entry = vault.passkeys.find(p => p.id === passkey.id);
			return entry
				? { vault: putPasskey(vault, { ...entry, signCount: Math.max(entry.signCount, signCount), lastUsed: now }), result: true }
				: undefined;
		});
	}

	// --- managing -------------------------------------------------------------

	private async _managerView(): Promise<LoginsView> {
		const config = settings();
		const shownSettings = {
			enabled: config.enabled, offerToSave: config.offerToSave, showSuggestions: config.suggest,
			autofillOnPageLoad: config.autofill, passkeys: config.passkeys,
		};
		let vault: Vault;
		try {
			vault = await this._vault.read();
		} catch (err) {
			return { logins: [], passkeys: [], neverSave: [], unreadable: 0, settings: shownSettings, error: errorText(err) };
		}
		return {
			logins: vault.logins.map(e => ({
				id: e.id, origin: e.origin, username: e.username, updated: e.updated,
				...(e.title ? { title: e.title } : {}), ...(e.lastUsed ? { lastUsed: e.lastUsed } : {}),
			})),
			passkeys: vault.passkeys.map(e => ({ id: e.id, rpId: e.rpId, userName: e.userName || e.userDisplayName || '', created: e.created })),
			neverSave: [...vault.neverSave],
			unreadable: (vault.unreadable?.logins.length ?? 0) + (vault.unreadable?.passkeys.length ?? 0),
			settings: shownSettings,
		};
	}

	private async _managerAct(action: LoginsAction): Promise<void> {
		switch (action.action) {
			case 'import': return this._import();
			case 'export': return this._export();
			case 'saveFromPage': return this._saveFromPage();
			case 'set':
				try {
					await vscode.workspace.getConfiguration('hoverdeck').update(settingIds[action.key], action.value, vscode.ConfigurationTarget.Global);
				} catch (err) {
					refuse(vscode.l10n.t("The setting was not changed: {0}", errorText(err)));
				}
				return;
			case 'offerAgain':
				if (await this._write(vault => vault.neverSave.includes(action.origin) ? { vault: setNeverSave(vault, action.origin, false), result: true } : undefined)) {
					confirm(vscode.l10n.t("Saving will be offered on {0} again", plainInLabel(action.origin)));
				}
				return;
		}
		const vault = await this._read();
		if (!vault) {
			return;
		}
		if (action.action === 'deletePasskey') {
			const entry = vault.passkeys.find(e => e.id === action.id);
			return entry ? this._deletePasskey(entry) : refuse(vscode.l10n.t("That passkey was deleted in the meantime."));
		}
		const entry = vault.logins.find(e => e.id === action.id);
		return entry ? this._loginOperation(entry, action.op) : refuse(vscode.l10n.t("That login was deleted in the meantime."));
	}

	private async _manage(): Promise<void> {
		if (await this.openManager?.().catch(() => false)) {
			return;
		}
		const vault = await this._read();
		if (!vault) {
			return;
		}
		type Choice =
			| { kind: 'login'; entry: LoginEntry }
			| { kind: 'passkey'; entry: PasskeyEntry }
			| { kind: 'never'; origin: string }
			| { kind: 'import' | 'export' | 'settings' };
		const items: Item<Choice>[] = [
			{ label: vscode.l10n.t("$(cloud-download) Import…"), detail: vscode.l10n.t("From an AI Browser or HoverDeck export, or a CSV from Chrome, Firefox, Safari, Bitwarden or 1Password"), value: { kind: 'import' } },
			{ label: vscode.l10n.t("$(cloud-upload) Export…"), value: { kind: 'export' } },
			{ label: vscode.l10n.t("$(gear) Settings"), value: { kind: 'settings' } },
		];
		const logins = [...vault.logins].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
		items.push(separator(vscode.l10n.t("Logins ({0})", logins.length)));
		for (const entry of logins) {
			items.push({
				label: `$(account) ${shownUsername(entry.username)}`,
				description: plainInLabel(entry.origin),
				detail: entry.title ? plainInLabel(entry.title) : vscode.l10n.t("Password changed {0}", day(entry.updated)),
				value: { kind: 'login', entry },
			});
		}
		if (vault.passkeys.length > 0) {
			items.push(separator(vscode.l10n.t("Passkeys ({0})", vault.passkeys.length)));
			for (const entry of [...vault.passkeys].sort((a, b) => a.rpId.localeCompare(b.rpId))) {
				items.push({
					label: `$(key) ${plainInLabel(entry.userName || entry.userDisplayName || vscode.l10n.t("(unnamed)"))}`,
					description: plainInLabel(entry.rpId),
					detail: vscode.l10n.t("Created {0}", day(entry.created)),
					value: { kind: 'passkey', entry },
				});
			}
		}
		if (vault.neverSave.length > 0) {
			items.push(separator(vscode.l10n.t("Never offered on")));
			for (const origin of [...vault.neverSave].sort()) {
				items.push({ label: `$(circle-slash) ${plainInLabel(origin)}`, value: { kind: 'never', origin } });
			}
		}
		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("Saved logins and passkeys"),
			placeHolder: vscode.l10n.t("Search by site or username"),
			matchOnDescription: true,
		});
		const choice = picked?.value;
		if (!choice) {
			return;
		}
		switch (choice.kind) {
			case 'import': return this._import();
			case 'export': return this._export();
			case 'settings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'hoverdeck.logins hoverdeck.passkeys');
				return;
			case 'login': return this._manageLogin(choice.entry);
			case 'passkey': return this._managePasskey(choice.entry);
			case 'never': {
				const again = vscode.l10n.t("Offer again");
				const answer = await vscode.window.showQuickPick([again], {
					title: vscode.l10n.t("Offer to save logins on {0} again?", plainInLabel(choice.origin)),
				});
				if (answer === again) {
					await this._write(vault => ({ vault: setNeverSave(vault, choice.origin, false), result: true }));
				}
				return;
			}
		}
	}

	private async _manageLogin(entry: LoginEntry): Promise<void> {
		type Action = LoginOperation;
		const picked = await vscode.window.showQuickPick<Item<Action>>([
			{ label: vscode.l10n.t("$(copy) Copy username"), value: 'copyUser' },
			{ label: vscode.l10n.t("$(copy) Copy password"), detail: vscode.l10n.t("Cleared from the clipboard after {0} seconds", clipboardClearMs / 1000), value: 'copyPassword' },
			{ label: vscode.l10n.t("$(edit) Change password…"), value: 'password' },
			{ label: vscode.l10n.t("$(edit) Change username…"), value: 'username' },
			{ label: vscode.l10n.t("$(tag) Rename…"), value: 'title' },
			{ label: vscode.l10n.t("$(globe) Open {0}", plainInLabel(entry.origin)), value: 'open' },
			{ label: vscode.l10n.t("$(trash) Delete…"), value: 'delete' },
		], { title: `${shownUsername(entry.username)} · ${plainInLabel(entry.origin)}` });
		if (picked?.value) {
			await this._loginOperation(entry, picked.value);
		}
	}

	/** One action on one saved login: the QuickPick's and Chat Settings' alike. */
	private async _loginOperation(entry: LoginEntry, op: LoginOperation): Promise<void> {
		const now = Date.now();
		// An edit of a login another window deleted meanwhile says so, instead of
		// doing nothing and saying nothing.
		const edit = async (change: (current: LoginEntry, vault: Vault) => LoginEntry | 'taken') => {
			let outcome: 'gone' | 'taken' | undefined;
			const done = await this._write(vault => {
				const current = vault.logins.find(e => e.id === entry.id);
				if (!current) {
					outcome = 'gone';
					return undefined;
				}
				const next = change(current, vault);
				if (next === 'taken') {
					outcome = 'taken';
					return undefined;
				}
				return { vault: putLogin(vault, next), result: true };
			});
			if (outcome === 'gone') {
				refuse(vscode.l10n.t("That login was deleted in the meantime."));
			} else if (outcome === 'taken') {
				refuse(vscode.l10n.t("Another login for {0} already has that username.", plainInLabel(entry.origin)));
			}
			return done;
		};
		switch (op) {
			case 'copyUser':
				await vscode.env.clipboard.writeText(entry.username);
				confirm(vscode.l10n.t("Username copied"));
				return;
			case 'copyPassword':
				await copySecret(entry.password);
				confirm(vscode.l10n.t("Password copied — cleared from the clipboard in {0} seconds", clipboardClearMs / 1000));
				return;
			case 'password': {
				const password = await vscode.window.showInputBox({
					title: vscode.l10n.t("New password for {0}", shownUsername(entry.username)),
					password: true,
					ignoreFocusOut: true,
					validateInput: value => value ? undefined : vscode.l10n.t("Enter a password"),
				});
				if (password && await edit(current => ({ ...current, password, updated: now }))) {
					confirm(vscode.l10n.t("Password changed"));
				}
				return;
			}
			case 'username': {
				const username = await vscode.window.showInputBox({
					title: vscode.l10n.t("Username for {0}", plainInLabel(entry.origin)),
					value: entry.username,
					ignoreFocusOut: true,
				});
				// A login is one origin and one username: renaming onto a name the
				// origin already has would make two, and every lookup after it
				// would act on whichever came first.
				if (username !== undefined && await edit((current, vault) =>
					vault.logins.some(e => e.id !== current.id && e.origin === current.origin && sameUsername(e.username, username.trim()))
						? 'taken' : { ...current, username: username.trim() })) {
					confirm(vscode.l10n.t("Username changed"));
				}
				return;
			}
			case 'title': {
				const title = await vscode.window.showInputBox({
					title: vscode.l10n.t("Name for this login"),
					value: entry.title ?? '',
					ignoreFocusOut: true,
				});
				if (title !== undefined && await edit(current => {
					const { title: _old, ...rest } = current;
					return title.trim() ? { ...rest, title: title.trim() } : rest;
				})) {
					confirm(vscode.l10n.t("Renamed"));
				}
				return;
			}
			case 'open':
				await vscode.commands.executeCommand('hoverdeck.show', entry.origin);
				return;
			case 'delete': {
				const remove = vscode.l10n.t("Delete");
				const answer = await vscode.window.showWarningMessage(
					vscode.l10n.t("Delete the login {0} for {1}?", entry.username || vscode.l10n.t("(no username)"), entry.origin),
					{ modal: true }, remove);
				if (answer === remove && await this._write(vault => ({ vault: removeLogin(vault, entry.id), result: true }))) {
					confirm(vscode.l10n.t("Login deleted"));
				}
				return;
			}
		}
	}

	private async _managePasskey(entry: PasskeyEntry): Promise<void> {
		const remove = vscode.l10n.t("$(trash) Delete…");
		const picked = await vscode.window.showQuickPick([remove], {
			title: `${plainInLabel(entry.userName || entry.userDisplayName || '')} · ${plainInLabel(entry.rpId)}`,
		});
		if (picked === remove) {
			await this._deletePasskey(entry);
		}
	}

	private async _deletePasskey(entry: PasskeyEntry): Promise<void> {
		const button = vscode.l10n.t("Delete");
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t("Delete the passkey for {0}?", entry.rpId),
			{
				modal: true,
				detail: vscode.l10n.t("The site keeps its half, so remove the passkey in the site's security settings too — otherwise it will keep offering a passkey nothing can answer."),
			},
			button);
		if (answer === button && await this._write(vault => ({ vault: removePasskey(vault, entry.id), result: true }))) {
			confirm(vscode.l10n.t("Passkey deleted"));
		}
	}

	// --- export and import ----------------------------------------------------

	private async _export(): Promise<void> {
		const vault = await this._read();
		if (!vault) {
			return;
		}
		// Entries this build could not read count: the encrypted export is how
		// they reach a build that can, and a vault holding only those is
		// exactly the one that needs it.
		const unreadable = (vault.unreadable?.logins.length ?? 0) + (vault.unreadable?.passkeys.length ?? 0);
		if (vault.logins.length === 0 && vault.passkeys.length === 0 && unreadable === 0) {
			refuse(vscode.l10n.t("Nothing is saved yet."));
			return;
		}
		type Format = 'sealed' | 'csv';
		const format = await vscode.window.showQuickPick<Item<Format>>([
			{
				label: vscode.l10n.t("$(lock) Encrypted file"),
				detail: vscode.l10n.t("Logins and passkeys, protected by a passphrase — for {0} on another machine", productName()),
				value: 'sealed',
			},
			{
				label: vscode.l10n.t("$(warning) CSV, not encrypted"),
				detail: vscode.l10n.t("Logins only, every password readable — for Chrome, Firefox, Safari, Bitwarden, 1Password"),
				value: 'csv',
			},
		], { title: vscode.l10n.t("Export {0} logins and {1} passkeys", vault.logins.length, vault.passkeys.length) });
		if (!format?.value) {
			return;
		}
		const stamp = new Date().toISOString().slice(0, 10);
		let data: string;
		let target: vscode.Uri | undefined;
		if (format.value === 'csv') {
			if (vault.logins.length === 0) {
				refuse(vscode.l10n.t("There are no logins this version can write to a CSV — use the encrypted export."));
				return;
			}
			const proceed = vscode.l10n.t("Export");
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t("Write {0} passwords to a file anyone who can read it can use?", vault.logins.length),
				{
					modal: true,
					detail: [
						vscode.l10n.t("Import it where it is going, then delete it."),
						// The cells are written as they are, so the password survives
						// exactly — and a spreadsheet program may run one that starts
						// like a formula. Usernames and titles come from pages.
						vscode.l10n.t("Do not open it in a spreadsheet program: a cell that starts with =, +, - or @ can run as a formula there."),
						vault.passkeys.length > 0
							? vscode.l10n.t("{0} passkeys are not included: CSV cannot carry them. Use the encrypted export for those.", vault.passkeys.length)
							: '',
					].filter(Boolean).join(' '),
				},
				proceed);
			if (answer !== proceed) {
				return;
			}
			target = await vscode.window.showSaveDialog({
				defaultUri: defaultExportUri(`ai-browser-logins-${stamp}.csv`),
				filters: { CSV: ['csv'] },
			});
			if (!target) {
				return;
			}
			if (target.scheme !== 'file') {
				// Only a local file's permissions can be set to its owner alone; a
				// remote file system writes it with that host's default, readable
				// by every user there.
				refuse(vscode.l10n.t("A plain CSV is written only to a local file, which can be made readable by you alone. Use the encrypted export for this location."));
				return;
			}
			data = loginsToCsv(vault.logins);
		} else {
			const passphrase = await askNewPassphrase();
			if (!passphrase) {
				return;
			}
			target = await vscode.window.showSaveDialog({
				defaultUri: defaultExportUri(`ai-browser-logins-${stamp}.aibvault`),
				filters: { [vscode.l10n.t("{0} export", productName())]: ['aibvault'] },
			});
			if (!target) {
				return;
			}
			data = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Encrypting…") },
				// The whole vault, entries this build could not read included:
				// an export is how they reach a build that can.
				() => seal(serializeVault({ ...vault, revision: undefined }), passphrase));
		}
		try {
			await writePrivately(target, data);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not write {0}: {1}", inBody(target.fsPath), inBody(errorText(err))));
			return;
		}
		confirm(vscode.l10n.t("Exported to {0}", plainInLabel(target.fsPath)));
	}

	private async _import(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: vscode.l10n.t("Import"),
			filters: {
				[vscode.l10n.t("{0} export or CSV", productName())]: ['aibvault', 'json', 'csv'],
				[vscode.l10n.t("All files")]: ['*'],
			},
		});
		const file = picked?.[0];
		if (!file) {
			return;
		}
		let text: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(file);
			if (bytes.byteLength > 50 * 1024 * 1024) {
				refuse(vscode.l10n.t("That file is too large to be a login export."));
				return;
			}
			text = new TextDecoder().decode(bytes);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not read {0}: {1}", inBody(file.fsPath), inBody(errorText(err))));
			return;
		}

		let incoming: { logins: LoginEntry[]; passkeys: PasskeyEntry[]; neverSave: string[]; undated?: Set<LoginEntry> };
		let skipped = 0;
		if (isSealed(text)) {
			const opened = await this._unsealInteractively(text);
			if (!opened) {
				return;
			}
			incoming = { logins: [...opened.vault.logins], passkeys: [...opened.vault.passkeys], neverSave: [...opened.vault.neverSave] };
			skipped = opened.dropped;
		} else {
			const read = loginsFromCsv(text);
			if (!read) {
				void vscode.window.showErrorMessage(vscode.l10n.t(
					"{0} is neither an AI Browser or HoverDeck export nor a CSV with url and password columns.", inBody(file.fsPath)));
				return;
			}
			const now = Date.now();
			skipped = read.skipped;
			const logins: LoginEntry[] = [];
			// Rows with no date of their own (every row of a Chrome, Safari,
			// Bitwarden or 1Password export) are stored with the import's time,
			// and that stamp must not be read as an age when two rows name one
			// account: see `distinctLogins`.
			const undated = new Set<LoginEntry>();
			for (const row of read.logins) {
				// The first of the row's addresses that is a web page. A bare
				// `example.com` is a site written without its scheme; anything with
				// `://` already has one, and an app login (`android://com.app`)
				// given an `https://` in front parses as the host `android` — a
				// website it never was.
				const origin = row.urls
					.map(url => originOf(url) ?? (url.includes('://') ? undefined : originOf(`https://${url}`)))
					.find(found => found !== undefined);
				if (!origin) {
					skipped++;
					continue;
				}
				const entry: LoginEntry = {
					id: newId(), origin, username: row.username, password: row.password,
					created: row.created ?? now, updated: row.updated ?? row.created ?? now,
					...(row.lastUsed ? { lastUsed: row.lastUsed } : {}),
					...(row.title ? { title: row.title } : {}),
					...(row.note ? { note: row.note } : {}),
				};
				if (row.updated === undefined && row.created === undefined) {
					undated.add(entry);
				}
				logins.push(entry);
			}
			incoming = { logins, passkeys: [], neverSave: [], undated };
		}

		const current = await this._read();
		if (!current) {
			return;
		}
		let policy: 'replace' | 'keep' = 'keep';
		const conflicts = countConflicts(current, incoming.logins, incoming.undated);
		if (conflicts > 0) {
			const replace = vscode.l10n.t("Use the imported passwords");
			const keep = vscode.l10n.t("Keep the saved passwords");
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t("{0} imported logins have a different password than the one saved here.", conflicts),
				{ modal: true }, replace, keep);
			if (!answer) {
				return;
			}
			policy = answer === replace ? 'replace' : 'keep';
		}
		const report = await this._write(vault => {
			const merged = mergeVault(vault, incoming, policy, Date.now());
			return { vault: merged.vault, result: merged };
		});
		if (report) {
			// "The newest used" only where the file could say which was newest:
			// an account repeated with different passwords and no dates is
			// counted apart, and named, since the first row was simply taken.
			confirm(report.duplicates === 0
				? vscode.l10n.t("Imported: {0} new, {1} updated, {2} already saved, {3} kept as they were, {4} skipped",
					report.added, report.updated, report.unchanged, report.kept, skipped)
				: report.undecided.length === 0
					? vscode.l10n.t("Imported: {0} new, {1} updated, {2} already saved, {3} kept as they were, {4} skipped, {5} repeated in the file (the newest used)",
						report.added, report.updated, report.unchanged, report.kept, skipped, report.duplicates)
					: vscode.l10n.t("Imported: {0} new, {1} updated, {2} already saved, {3} kept as they were, {4} skipped, {5} repeated in the file — for {6} accounts with different passwords and no dates, the first row used",
						report.added, report.updated, report.unchanged, report.kept, skipped, report.duplicates, report.undecided.length));
			if (report.undecided.length > 0) {
				// A question of which password is current, which only the user can
				// answer: modal, like the conflict question before the merge, and
				// gone with one click rather than left over a browser page.
				const named = report.undecided.slice(0, 5)
					.map(account => inBody(`${shownUsername(account.username)} · ${account.origin}`)).join('\n');
				const more = report.undecided.length > 5
					? '\n' + vscode.l10n.t("and {0} more", report.undecided.length - 5) : '';
				void vscode.window.showWarningMessage(
					vscode.l10n.t("{0} accounts appear more than once in the file with different passwords, and the file has no dates to tell which is newer. The first row for each was used. Check that these passwords are current:", report.undecided.length),
					{ modal: true, detail: named + more });
			}
		}
	}

	private async _unsealInteractively(text: string): Promise<{ vault: Vault; dropped: number } | undefined> {
		for (;;) {
			const passphrase = await vscode.window.showInputBox({
				title: vscode.l10n.t("Passphrase of the export"),
				password: true,
				ignoreFocusOut: true,
				validateInput: value => value ? undefined : vscode.l10n.t("Enter the passphrase"),
			});
			if (!passphrase) {
				return undefined;
			}
			try {
				const plain = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Decrypting…") },
					() => unseal(text, passphrase));
				const parsed = parseVault(plain);
				if (!parsed) {
					void vscode.window.showErrorMessage(vscode.l10n.t("The export was made by a newer version of {0}.", productName()));
					return undefined;
				}
				return parsed;
			} catch (err) {
				if (err instanceof SealError && err.reason === 'wrongPassphrase') {
					refuse(vscode.l10n.t("Wrong passphrase, or the file is damaged."));
					continue;
				}
				// Fixed wording for the reasons the file decides, never the
				// file's own text: see `inBody`.
				void vscode.window.showErrorMessage(err instanceof SealError
					? err.reason === 'notSealed'
						? vscode.l10n.t("This is not an AI Browser or HoverDeck export.")
						: vscode.l10n.t("This export was made by a newer version of {0}, or uses settings this version does not accept.", productName())
					: vscode.l10n.t("Could not decrypt the export: {0}", inBody(errorText(err))));
				return undefined;
			}
		}
	}

	public dispose(): void {
		this._clearOffer();
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
	}
}

/**
 * A QuickPick that also closes when `token` is cancelled — the page gave up
 * on its passkey request, so the question no longer has anyone to answer.
 */
function pickWithCancellation<T>(items: Item<T>[], options: { title: string; placeHolder: string }, token: vscode.CancellationToken): Promise<T | undefined> {
	return new Promise(resolve => {
		const pick = vscode.window.createQuickPick<Item<T>>();
		pick.items = items;
		pick.title = options.title;
		pick.placeholder = options.placeHolder;
		let settled = false;
		const finish = (value: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			subscriptions.forEach(s => s.dispose());
			pick.dispose();
			resolve(value);
		};
		const subscriptions = [
			pick.onDidAccept(() => finish(pick.selectedItems[0]?.value)),
			pick.onDidHide(() => finish(undefined)),
			token.onCancellationRequested(() => finish(undefined)),
		];
		if (token.isCancellationRequested) {
			finish(undefined);
			return;
		}
		pick.show();
	});
}

/** Asks for a passphrase twice. Short ones are refused: the file may travel. */
async function askNewPassphrase(): Promise<string | undefined> {
	const first = await vscode.window.showInputBox({
		title: vscode.l10n.t("Passphrase for the export"),
		prompt: vscode.l10n.t("At least 10 characters. Without it the file cannot be opened — it is not stored anywhere."),
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value.length >= 10 ? undefined : vscode.l10n.t("At least 10 characters"),
	});
	if (!first) {
		return undefined;
	}
	const second = await vscode.window.showInputBox({
		title: vscode.l10n.t("Repeat the passphrase"),
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value === first ? undefined : vscode.l10n.t("The passphrases differ"),
	});
	return second === first ? first : undefined;
}

function defaultExportUri(name: string): vscode.Uri | undefined {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	return home ? vscode.Uri.joinPath(vscode.Uri.file(home), name) : undefined;
}

/**
 * A local file is written `0600` and atomically — `0600` even over an existing
 * file, whose old mode says nothing about a file now holding passwords. Anything
 * else goes through the file system provider.
 */
async function writePrivately(target: vscode.Uri, data: string): Promise<void> {
	if (target.scheme === 'file') {
		await writeFileAtomic(target.fsPath, data, 0o600, false);
	} else {
		await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(data));
	}
}

/**
 * Puts a secret on the clipboard and takes it off again — but only if it is
 * still there, so whatever the user copied in the meantime survives.
 */
async function copySecret(secret: string): Promise<void> {
	await vscode.env.clipboard.writeText(secret);
	const timer = setTimeout(async () => {
		try {
			if (await vscode.env.clipboard.readText() === secret) {
				await vscode.env.clipboard.writeText('');
			}
		} catch {
			// The clipboard is not ours to insist on.
		}
	}, clipboardClearMs);
	timer.unref?.();
}
