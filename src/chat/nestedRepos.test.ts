import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { findRepos, gitFileKind } from './nestedRepos.ts';

function tree(spec: Record<string, string | null>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
	for (const [name, content] of Object.entries(spec)) {
		const target = path.join(root, name);
		if (content === null) { fs.mkdirSync(target, { recursive: true }); }
		else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
	}
	return root;
}

test('gitFileKind tells a submodule and a worktree from a plain gitdir', () => {
	assert.equal(gitFileKind('gitdir: ../../.git/modules/libs/ui\n'), 'submodule');
	assert.equal(gitFileKind('gitdir: /repos/app/.git/worktrees/feature\n'), 'worktree');
	assert.equal(gitFileKind('gitdir: C:\\repos\\app\\.git\\worktrees\\x'), 'worktree');
	assert.equal(gitFileKind('gitdir: /elsewhere/store.git'), 'nested');
	assert.equal(gitFileKind('nonsense'), 'nested');
});

test('the working folder comes first, nested repositories sorted after it', async () => {
	const root = tree({ '.git': null, 'services/api/.git': null, 'apps/web/.git': null, 'libs/ui/.git': 'gitdir: ../../.git/modules/libs/ui\n', 'src/index.ts': '' });
	const repos = await findRepos(root);
	assert.deepEqual(repos.map(r => [r.name, r.kind]), [['', 'root'], ['apps/web', 'nested'], ['libs/ui', 'submodule'], ['services/api', 'nested']]);
	assert.equal(repos[0].path, path.resolve(root));
});

test('a folder that is not a repository lists only what is inside it', async () => {
	const root = tree({ 'a/.git': null, 'b/.git': null, 'notes.txt': '' });
	assert.deepEqual((await findRepos(root)).map(r => r.name), ['a', 'b']);
});

test('heavy folders, links and depth are not searched', async () => {
	const root = tree({ 'node_modules/pkg/.git': null, 'x/y/z/w/.git': null, 'x/y/near/.git': null });
	fs.mkdirSync(path.join(root, 'elsewhere/.git'), { recursive: true });
	fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'link'));
	const names = (await findRepos(root)).map(r => r.name);
	assert.deepEqual(names, ['elsewhere', 'x/y/near']);
});

test('the limit holds', async () => {
	const spec: Record<string, null> = {};
	for (let i = 0; i < 10; i++) { spec[`r${i}/.git`] = null; }
	assert.equal((await findRepos(tree(spec), { limit: 4 })).length, 4);
});

test('parseStatusSummary reads the branch line and counts files', async () => {
	const { parseStatusSummary } = await import('./nestedRepos.ts');
	assert.deepEqual(parseStatusSummary('## main...origin/main [ahead 2, behind 3]\0 M a.ts\0R  new.ts\0old.ts\0?? x\0'), { branch: 'main', ahead: 2, behind: 3, changes: 3 });
	assert.deepEqual(parseStatusSummary('## HEAD (no branch)\0'), { detached: true, ahead: 0, behind: 0, changes: 0 });
	assert.deepEqual(parseStatusSummary('## No commits yet on feat/x\0'), { branch: 'feat/x', ahead: 0, behind: 0, changes: 0 });
	assert.deepEqual(parseStatusSummary('## main\0 R b\0a\0?? x\0'), { branch: 'main', ahead: 0, behind: 0, changes: 2 }, 'a rename in the worktree column');
	assert.deepEqual(parseStatusSummary('## dev\0'), { branch: 'dev', ahead: 0, behind: 0, changes: 0 });
});
