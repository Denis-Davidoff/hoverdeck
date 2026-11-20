/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Chat Settings → Logins: what the chat's webview is shown of the vault, and
 * what it may ask for. No imports, so both builds and `npm test` read it.
 *
 * **No password ever crosses this boundary**, in either direction. The view
 * gets origins, usernames, titles and dates; copying a password, or changing
 * one, is done by the extension host (the host clipboard, an input box it
 * shows), so the webview never holds one.
 */

export interface LoginsViewLogin {
	readonly id: string;
	readonly origin: string;
	readonly username: string;
	readonly title?: string;
	readonly updated: number;
	readonly lastUsed?: number;
}

export interface LoginsViewPasskey {
	readonly id: string;
	readonly rpId: string;
	readonly userName: string;
	readonly created: number;
}

export interface LoginsSettings {
	readonly enabled: boolean;
	readonly offerToSave: boolean;
	readonly showSuggestions: boolean;
	readonly autofillOnPageLoad: boolean;
	readonly passkeys: boolean;
}

export type LoginsSettingKey = keyof LoginsSettings;

export const loginsSettingKeys: readonly LoginsSettingKey[] = ['enabled', 'offerToSave', 'showSuggestions', 'autofillOnPageLoad', 'passkeys'];

export interface LoginsView {
	readonly logins: readonly LoginsViewLogin[];
	readonly passkeys: readonly LoginsViewPasskey[];
	readonly neverSave: readonly string[];
	/** Entries this build cannot read; kept, exported, never shown. */
	readonly unreadable: number;
	readonly settings: LoginsSettings;
	/** The vault could not be read at all. */
	readonly error?: string;
}

export type LoginOperation = 'copyUser' | 'copyPassword' | 'password' | 'username' | 'title' | 'open' | 'delete';

export type LoginsAction =
	| { readonly action: 'login'; readonly id: string; readonly op: LoginOperation }
	| { readonly action: 'deletePasskey'; readonly id: string }
	| { readonly action: 'offerAgain'; readonly origin: string }
	| { readonly action: 'import' | 'export' | 'saveFromPage' }
	| { readonly action: 'set'; readonly key: LoginsSettingKey; readonly value: boolean };

const loginOperations: readonly LoginOperation[] = ['copyUser', 'copyPassword', 'password', 'username', 'title', 'open', 'delete'];

/** An action as the view sent it, or `undefined` when it is not a well-formed one. */
export function readLoginsAction(raw: any): LoginsAction | undefined {
	const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
	switch (raw?.action) {
		case 'login':
			return id(raw.id) && loginOperations.includes(raw.op) ? { action: 'login', id: raw.id, op: raw.op } : undefined;
		case 'deletePasskey':
			return id(raw.id) ? { action: 'deletePasskey', id: raw.id } : undefined;
		case 'offerAgain':
			return typeof raw.origin === 'string' && raw.origin.length <= 2048 ? { action: 'offerAgain', origin: raw.origin } : undefined;
		case 'import':
		case 'export':
		case 'saveFromPage':
			return { action: raw.action };
		case 'set':
			return loginsSettingKeys.includes(raw.key) && typeof raw.value === 'boolean' ? { action: 'set', key: raw.key, value: raw.value } : undefined;
	}
	return undefined;
}

/** What the logins feature offers the chat. */
export interface LoginsManager {
	view(): Promise<LoginsView>;
	/** Carries out an action; resolves once it is done or refused (the refusal said in the status bar). */
	act(action: LoginsAction): Promise<void>;
	onDidChange(listener: () => void): { dispose(): void };
}

let current: LoginsManager | undefined;

export function setLoginsManager(manager: LoginsManager | undefined): void {
	current = manager;
}

/** The logins feature, once it is running. */
export function loginsManager(): LoginsManager | undefined {
	return current;
}
