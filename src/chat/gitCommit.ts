/** Git is injected so the same workflow can be exercised against temporary repositories. */
export type CommitGit = (args: readonly string[]) => Promise<string>;
export type CommitScope = 'smart' | 'staged' | 'all';

/** The first `limit` UTF-16 units, never ending inside a surrogate pair (written twice: `headUnits` in featureAi.ts, leaf rule). */
function headUnits(text: string, limit: number): string {
	if (text.length <= limit) { return text; }
	const end = /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? limit - 1 : limit;
	return text.slice(0, Math.max(0, end));
}

/** The last `limit` UTF-16 units, never starting inside a surrogate pair (written twice: `tailUnits` in featureAi.ts, leaf rule). */
function tailUnits(text: string, limit: number): string {
	if (text.length <= limit) { return text; }
	let start = text.length - limit;
	if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) { start++; }
	return text.slice(start);
}

export function commitContext(files: string, diff: string, history: string, branch = '', conversation = ''): string {
	const limit = 120_000;
	// The branch is where a task ID usually is (feature/ABC-123-…); it is data, like the rest.
	const branchLine = branch.trim() ? `Branch: ${branch.trim().split('\n')[0].slice(0, 200)}\n\n` : '';
	// The chat explains why; it goes before the diff so a long diff cannot push it out.
	// Its newest end is kept, where a reply's summary is, as the branch-name path does.
	const talk = conversation.trim() ? `Recent conversation (intent only; describe the diff):\n${tailUnits(conversation.trim(), 12_000)}\n\n` : '';
	const header = `${branchLine}${talk}Recent commit subjects (style and task IDs only):\n${headUnits(history, 2000)}\n\nStaged files:\n${headUnits(files, 20_000)}\n\nStaged diff:\n`;
	const room = limit - header.length - 80;
	return header + headUnits(diff, room) + (diff.length > room ? '\n[Diff truncated; summarize only the changes shown.]' : '');
}

/** The longest message the user may write by hand, in UTF-16 units. */
export const manualCommitMessageLimit = 20_000;

/**
 * A message the user wrote in the Commit window, as it will be committed:
 * line endings made `\n`, trailing spaces off each line, blank lines off both
 * ends. `undefined` for one that is empty, too long or holds a NUL (which
 * `git commit -m` cannot carry). Comment lines are kept: `--cleanup=verbatim`.
 */
export function manualCommitMessage(text: unknown): string | undefined {
	if (typeof text !== 'string' || text.length > manualCommitMessageLimit * 2 || text.includes('\0')) { return undefined; }
	const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd());
	// Blank lines off both ends, without a backtracking pattern over a run of them.
	let start = 0, end = lines.length;
	while (start < end && !lines[start]) { start++; }
	while (end > start && !lines[end - 1]) { end--; }
	const message = lines.slice(start, end).join('\n');
	return message.trim() && message.length <= manualCommitMessageLimit ? message : undefined;
}

/** Commit Staged, or stage all when the index is empty. Never include unstaged edits in a staged commit. */
export async function commitChanges(git: CommitGit, generate: (context: string) => Promise<string>, guard: () => void, phase: (phase: 'generating' | 'committing') => void, scope: CommitScope = 'smart', conversation = ''): Promise<{ message: string; hash: string }> {
	guard();
	await git(['rev-parse', '--show-toplevel']);
	const unresolved = await git(['diff', '--name-only', '--diff-filter=U', '-z']);
	if (unresolved) { throw new Error('Resolve merge conflicts before committing.'); }
	let files = await git(['diff', '--cached', '--no-relative', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv']);
	if (scope === 'all' || (!files && scope === 'smart')) {
		guard();
		await git(['add', '--all', '--', ':/']);
		files = await git(['diff', '--cached', '--no-relative', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv']);
	}
	if (!files.trim()) { throw new Error(scope === 'staged' ? 'No staged changes to commit.' : 'No changes to commit.'); }
	const tree = (await git(['write-tree'])).trim();
	const head = async () => {
		const ref = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '');
		const hash = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
		return `${ref.trim()}\n${hash.trim()}`;
	};
	const originalHead = await head();
	const [diff, history, branch] = await Promise.all([
		git(['diff', '--cached', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3']),
		git(['log', '-5', '--format=%s']).catch(() => ''),
		git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
	]);
	guard();
	if ((await git(['write-tree'])).trim() !== tree) { throw new Error('The staged files changed while reading the diff. Press Commit again.'); }
	phase('generating');
	const message = await generate(commitContext(files, diff, history, branch, conversation));
	guard();
	if ((await git(['write-tree'])).trim() !== tree || await head() !== originalHead) {
		throw new Error('The staged files or branch changed while the message was being generated. Review the changes and press Commit again.');
	}
	guard();
	phase('committing');
	// Message is a single execFile argument, never a shell command. Git still runs its normal commit checks.
	await git(['commit', '--cleanup=verbatim', '-m', message]);
	const hash = (await git(['rev-parse', '--short', 'HEAD'])).trim();
	return { message, hash };
}
