/**
 * The Git repositories inside a working folder: the folder's own and the ones
 * nested under it (a clone kept beside the project, a submodule, a worktree).
 *
 * Found by walking the file system for a `.git` entry, **never by running git**:
 * reading a repository runs its own `core.fsmonitor` and filter commands (#208),
 * and nothing here says a nested repository is trusted. Git runs later through
 * the footer's guarded path: the full read for the repository the user picks, and
 * one `git status -b` per repository for the summary line of each (at most 12).
 * Leaf module, no `vscode`, under test.
 */
import * as fs from 'fs';
import * as path from 'path';

export type NestedRepoKind = 'root' | 'nested' | 'submodule' | 'worktree';

export interface NestedRepo {
	/** Absolute path of the repository's top folder. */
	readonly path: string;
	/** Relative to the working folder, with `/`; `''` for the working folder itself. */
	readonly name: string;
	readonly kind: NestedRepoKind;
}

export interface FindReposOptions {
	/** How many folder levels below the working folder are searched. */
	readonly depth?: number;
	/** At most this many repositories are listed. */
	readonly limit?: number;
	/** At most this many folders are read. */
	readonly folders?: number;
	/** Give up after this many milliseconds; what was found by then is returned. */
	readonly timeoutMs?: number;
}

/** Folders that are never a project's own repository and can be enormous. */
const skipped = new Set(['node_modules', '.git', '.hg', '.svn', 'bower_components', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'out', 'target', '.gradle', '.idea', '.cache', 'Pods', 'DerivedData']);

/**
 * Whether a `.git` file names a submodule or a worktree. Its first line is
 * `gitdir: <path>`; a submodule's points into the parent's `.git/modules/`, a
 * worktree's into another repository's `.git/worktrees/`.
 */
export function gitFileKind(text: string): 'submodule' | 'worktree' | 'nested' {
	const line = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/\\/g, '/') ?? '';
	if (/(^|\/)\.git\/modules\//.test(line)) { return 'submodule'; }
	if (/(^|\/)worktrees\/[^/]+\/?$/.test(line)) { return 'worktree'; }
	return 'nested';
}

/** Is `folder` itself the top of a repository (`.git` directly in it)? Read without following links. */
async function gitEntry(folder: string): Promise<'dir' | 'file' | undefined> {
	try {
		const stat = await fs.promises.lstat(path.join(folder, '.git'));
		return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
	} catch { return undefined; }
}

/** Is `folder` inside some repository, its own `.git` or one above it? */
export async function insideRepository(folder: string): Promise<boolean> {
	let current = path.resolve(folder);
	for (let i = 0; i < 64; i++) {
		if (await gitEntry(current)) { return true; }
		const parent = path.dirname(current);
		if (parent === current) { return false; }
		current = parent;
	}
	return false;
}

/**
 * The repositories in `root`: the working folder first when it is inside a
 * repository (its own or one above it — git finds that one), then the nested
 * ones breadth first, sorted by name. Symbolic links are never entered.
 */
export async function findRepos(root: string, options: FindReposOptions = {}): Promise<NestedRepo[]> {
	const depth = options.depth ?? 3;
	const limit = options.limit ?? 30;
	const budget = options.folders ?? 4000;
	const deadline = Date.now() + (options.timeoutMs ?? 1500);
	const top = path.resolve(root);
	const found: NestedRepo[] = [];
	if (await insideRepository(top)) { found.push({ path: top, name: '', kind: 'root' }); }
	let level = [top];
	let read = 0;
	for (let d = 1; d <= depth && level.length && found.length < limit; d++) {
		const next: string[] = [];
		for (const folder of level) {
			if (read++ >= budget || Date.now() > deadline || found.length >= limit) { break; }
			let entries: fs.Dirent[];
			try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { continue; }
			for (const entry of entries) {
				if (!entry.isDirectory() || skipped.has(entry.name)) { continue; }
				const child = path.join(folder, entry.name);
				const git = await gitEntry(child);
				if (git) {
					let kind: NestedRepoKind = 'nested';
					if (git === 'file') {
						try { kind = gitFileKind((await fs.promises.readFile(path.join(child, '.git'), 'utf8')).slice(0, 4096)); } catch { kind = 'nested'; }
					}
					found.push({ path: child, name: path.relative(top, child).split(path.sep).join('/'), kind });
					if (found.length >= limit) { break; }
				}
				// A repository's own folders can hold more repositories (submodules), so keep going.
				if (!entry.name.startsWith('.') || git) { next.push(child); }
			}
		}
		level = next;
	}
	const [first, ...rest] = found;
	if (first?.kind === 'root') { return [first, ...rest.sort((a, b) => a.name.localeCompare(b.name))]; }
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

export interface RepoStatusSummary {
	readonly branch?: string;
	/** HEAD is on a commit, not a branch (a submodule usually is). */
	readonly detached?: boolean;
	readonly ahead: number;
	readonly behind: number;
	/** Files with any change, staged or not, untracked included. */
	readonly changes: number;
}

/** Reads `git status --porcelain=v1 -b -z`: the `## ` header, then one entry per file (a rename takes two). */
export function parseStatusSummary(output: string): RepoStatusSummary {
	const parts = output.split('\0');
	let branch: string | undefined;
	let detached = false;
	let ahead = 0, behind = 0, changes = 0;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part) { continue; }
		if (part.startsWith('## ')) {
			const head = part.slice(3);
			if (/^HEAD \(no branch\)/.test(head)) { detached = true; }
			else {
				const name = head.replace(/^No commits yet on /, '').split('...')[0].split(' [')[0].trim();
				branch = name || undefined;
			}
			ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
			behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
			continue;
		}
		changes++;
		// A rename or copy names its source in the next entry, staged (`R `) or not (` R`).
		if (/[RC]/.test(part.slice(0, 2))) { i++; }
	}
	return { ...(branch ? { branch } : {}), ...(detached ? { detached } : {}), ahead, behind, changes };
}
