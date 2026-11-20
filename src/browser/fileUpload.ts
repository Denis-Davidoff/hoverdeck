/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The rules behind `browser_upload_file`: which files an agent may put into a
 * page's file input, and whether the user is asked first. Leaf module, no
 * `vscode`, under test.
 *
 * An upload sends a local file to whatever site the page belongs to, so it is
 * the shortest road from "a page told the agent to" to a leaked file. Hence:
 * - a chat agent follows the chat's approval menu — "Files in the project" for
 *   files inside the conversation's folder, "Files outside the project" for the
 *   rest (the stricter of the two when the files are mixed). Deny refuses,
 *   Ask asks, Auto uploads without a question;
 * - an agent outside the chat (Claude Code or Codex in a terminal) has no menu,
 *   so it is asked while the `confirmUploads` guard is on;
 * - a file that looks like a secret (`.env`, keys, credentials) is always
 *   asked about, whatever the menu says, unless the guard is off.
 */

export type UploadMode = 'auto' | 'ask' | 'deny';

/** The chat's approval modes that govern an upload; absent for a caller outside the chat. */
export interface UploadPolicy {
	readonly inside: UploadMode;
	readonly outside: UploadMode;
}

export interface UploadFile {
	readonly path: string;
	readonly outside: boolean;
}

export type UploadVerdict =
	| { readonly kind: 'allow' }
	| { readonly kind: 'ask'; readonly reason: 'policy' | 'noPolicy' | 'sensitive' }
	| { readonly kind: 'deny'; readonly category: 'inside' | 'outside' };

/** At most this many files in one call. */
export const maxUploadFiles = 20;
/** At most this many bytes a file. */
export const maxUploadBytes = 100 * 1024 * 1024;

const rank: Record<UploadMode, number> = { auto: 0, ask: 1, deny: 2 };

export function uploadVerdict(files: readonly UploadFile[], policy: UploadPolicy | undefined, guardOn: boolean): UploadVerdict {
	if (policy) {
		let mode: UploadMode = 'auto';
		let category: 'inside' | 'outside' = 'inside';
		for (const file of files) {
			const m = file.outside ? policy.outside : policy.inside;
			if (rank[m] > rank[mode]) { mode = m; category = file.outside ? 'outside' : 'inside'; }
		}
		if (mode === 'deny') { return { kind: 'deny', category }; }
		if (!guardOn) { return { kind: 'allow' }; }
		if (files.some(f => isSensitiveFile(f.path))) { return { kind: 'ask', reason: 'sensitive' }; }
		return mode === 'ask' ? { kind: 'ask', reason: 'policy' } : { kind: 'allow' };
	}
	if (!guardOn) { return { kind: 'allow' }; }
	return { kind: 'ask', reason: files.some(f => isSensitiveFile(f.path)) ? 'sensitive' : 'noPolicy' };
}

const sensitiveNames = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|asc|gpg))$/i;
const sensitiveFolders = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config[\\/]gcloud|\.azure)([\\/]|$)/i;

/** A file whose name or folder says it holds a secret. `.env.example` and friends are not secrets. */
export function isSensitiveFile(path: string): boolean {
	const name = path.split(/[\\/]/).pop() ?? '';
	if (/^\.env\.(example|sample|template|dist)$/i.test(name)) { return false; }
	return sensitiveNames.test(name) || sensitiveFolders.test(path);
}

/** Reads the tool's `paths` argument: a string or an array of non-empty strings, 1 to `maxUploadFiles`. */
export function uploadPathsArgument(value: unknown): string[] {
	const list = typeof value === 'string' ? [value] : value;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error('"paths" must be a file path or an array of file paths.');
	}
	if (list.length > maxUploadFiles) {
		throw new Error(`At most ${maxUploadFiles} files at once; ${list.length} were given.`);
	}
	return list.map(item => {
		if (typeof item !== 'string' || !item.trim() || /[\u0000-\u001f]/.test(item)) {
			throw new Error('Every entry of "paths" must be a file path on one line.');
		}
		return item.trim();
	});
}

/** A size for a question: 512 B, 3.4 KB, 12 MB. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) { return `${bytes} B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`; }
	return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
