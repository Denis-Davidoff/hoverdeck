import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { canOfferPullRequest, mergedPullRequest, githubFieldError, parseCreatedPr, pullRequestBody, pullRequestHead, pullRequestTitle, parseApiPullRequests, parseApiRuns, parseGhPullRequests, parseGhRuns, parseGhWorkflows, pickGithubRemote, workflowFileUrl, workflowPath, runState, summarizeChecks, parseWatchedRun, runWatchKey, runInFlight, runEndedText, runsForPullRequest, githubLogin, isOwnPullRequest, isOwnRun, parseGhRunActors } from './githubStatus.ts';
import type { GithubRun } from './githubStatus.ts';

test('summarizeChecks mixes check runs and status contexts', () => {
	deepStrictEqual(summarizeChecks([
		{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' },
		{ status: 'COMPLETED', conclusion: 'FAILURE' }, { state: 'PENDING' }, { state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' },
	]), { passed: 3, failed: 1, pending: 2 });
	strictEqual(summarizeChecks([]), undefined);
	strictEqual(summarizeChecks(null), undefined);
});

test('runState', () => {
	strictEqual(runState('in_progress', null), 'running');
	strictEqual(runState('queued', null), 'queued');
	strictEqual(runState('completed', 'success'), 'success');
	strictEqual(runState('completed', 'timed_out'), 'failure');
	strictEqual(runState('COMPLETED', 'CANCELLED'), 'cancelled');
	strictEqual(runState('completed', 'action_required'), 'other');
});

test('gh pull requests: fields, current branch, junk dropped', () => {
	const prs = parseGhPullRequests(JSON.stringify([
		{ number: 7, title: 'Fix\nit', url: 'https://github.com/o/n/pull/7', author: { login: 'me' }, headRefName: 'feat', isDraft: true, updatedAt: '2026-10-30T10:00:00Z', reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
		{ number: 8, url: 'javascript:alert(1)' },
		{ title: 'no number', url: 'https://github.com/o/n/pull/9' },
	]), 'feat');
	strictEqual(prs.length, 1);
	deepStrictEqual(prs[0], { number: 7, url: 'https://github.com/o/n/pull/7', title: 'Fix it', author: 'me', branch: 'feat', draft: true, updatedAt: '2026-10-30T10:00:00Z', review: 'APPROVED', checks: { passed: 1, failed: 0, pending: 0 }, current: true });
	throws(() => parseGhPullRequests('{}'));
});

test('gh runs and API runs read alike', () => {
	const gh = parseGhRuns(JSON.stringify([{ databaseId: 5, name: 'CI', displayTitle: 'feat: x', url: 'https://github.com/o/n/actions/runs/5', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'failure', updatedAt: 't' }]), 'main');
	const api = parseApiRuns(JSON.stringify({ workflow_runs: [{ id: 5, name: 'CI', display_title: 'feat: x', html_url: 'https://github.com/o/n/actions/runs/5', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', updated_at: 't' }] }), 'main');
	deepStrictEqual(gh, api);
	strictEqual(gh[0].state, 'failure');
	strictEqual(gh[0].current, true);
});

test('API pull requests', () => {
	const prs = parseApiPullRequests(JSON.stringify([{ number: 3, title: 'A', html_url: 'https://github.com/o/n/pull/3', user: { login: 'u' }, head: { ref: 'b' }, draft: false, updated_at: 't' }]));
	deepStrictEqual(prs, [{ number: 3, url: 'https://github.com/o/n/pull/3', title: 'A', author: 'u', branch: 'b', draft: false, updatedAt: 't', review: '' }]);
});

test('pickGithubRemote prefers the upstream branch remote, then upstream, then origin', () => {
	const parse = (url: string) => url.includes('github.com') ? url : undefined;
	const remotes = [{ name: 'gitlab', url: 'gitlab.com/x' }, { name: 'origin', url: 'github.com/me/n' }, { name: 'upstream', url: 'github.com/o/n' }, { name: 'mine', url: 'github.com/m/n' }];
	strictEqual(pickGithubRemote(remotes, parse, 'mine'), 'github.com/m/n');
	strictEqual(pickGithubRemote(remotes, parse), 'github.com/o/n');
	strictEqual(pickGithubRemote(remotes, parse, 'gitlab'), 'github.com/o/n');
	strictEqual(pickGithubRemote([{ name: 'a', url: 'x' }], parse), undefined);
});

test('a pull request is offered for a branch that has none and is not the default', () => {
	const base = { repo: 'o/n', source: 'gh' as const, prs: [], runs: [], defaultBranch: 'main' };
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat' }), true);
	strictEqual(canOfferPullRequest({ ...base, branch: 'main' }), false);
	strictEqual(canOfferPullRequest({ ...base }), false);
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', defaultBranch: undefined }), false);
	const pr = { number: 1, title: 't', url: 'https://github.com/o/n/pull/1', author: 'a', branch: 'feat', draft: false, updatedAt: '', review: '' };
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', prs: [pr] }), false);
	// A merged pull request's branch, deleted on the remote: nothing to open a pull request for.
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', upstreamGone: true }), false);
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', mergedPr: { number: 7, url: 'https://github.com/o/r/pull/7' } }), false);
});

test('the head names the fork when the branch was pushed elsewhere', () => {
	strictEqual(pullRequestHead('o/n', 'o/n', 'feat'), 'feat');
	strictEqual(pullRequestHead('o/n', 'O/N', 'feat'), 'feat');
	strictEqual(pullRequestHead('o/n', undefined, 'feat'), 'feat');
	strictEqual(pullRequestHead('up/n', 'me/n', 'feat'), 'me:feat');
});

test('PR identity includes the head repository for both API and gh results', () => {
	const api = parseApiPullRequests(JSON.stringify([{ number: 1, html_url: 'https://github.com/team/project/pull/1', head: { ref: 'fix', repo: { full_name: 'alice/project' } } }]));
	const gh = parseGhPullRequests(JSON.stringify([{ number: 1, url: 'https://github.com/team/project/pull/1', headRefName: 'fix', headRepository: { name: 'project' }, headRepositoryOwner: { login: 'alice' } }]));
	for (const prs of [api, gh]) {
		strictEqual(prs[0].headRepo, 'alice/project');
		const status = { repo: 'team/project', source: 'gh' as const, branch: 'fix', defaultBranch: 'main', prs, runs: [] };
		strictEqual(canOfferPullRequest(status), true, 'a different fork must not hide creation');
		strictEqual(canOfferPullRequest({ ...status, pushRepo: 'ALICE/PROJECT' }), false, 'the same fork and branch already have a PR');
		strictEqual(canOfferPullRequest({ ...status, prs: [{ ...prs[0], headRepo: 'team/project' }] }), false);
		strictEqual(canOfferPullRequest({ ...status, branch: 'local', headBranch: 'fix', pushRepo: 'alice/project' }), false);
	}
});

test('title and body are one line each and bounded', () => {
	strictEqual(pullRequestTitle('  fix\nthing  '), 'fix thing');
	strictEqual(pullRequestTitle('   '), undefined);
	strictEqual(pullRequestTitle(5), undefined);
	strictEqual(pullRequestTitle('x'.repeat(257)), undefined);
	strictEqual(pullRequestBody(['one']), '');
	strictEqual(pullRequestBody(['one', '', 'two']), '- one\n- two');
});

test('the created pull request is read from the API and from gh', () => {
	deepStrictEqual(parseCreatedPr('{"number":7,"html_url":"https://github.com/o/n/pull/7"}'), { number: 7, url: 'https://github.com/o/n/pull/7' });
	deepStrictEqual(parseCreatedPr('Creating...\nhttps://github.com/o/n/pull/12\n'), { number: 12, url: 'https://github.com/o/n/pull/12' });
	strictEqual(parseCreatedPr('{"number":7,"html_url":"https://evil.example/x"}'), undefined);
	strictEqual(parseCreatedPr('nothing'), undefined);
});

test('githubFieldError explains a code-only validation error', () => {
	strictEqual(githubFieldError({ field: 'head', code: 'invalid' }), 'The branch is not on GitHub. Push it (Branches window → Publish), then try again.');
	strictEqual(githubFieldError({ field: 'title', code: 'missing_field' }), 'Validation failed: title is missing field.');
	strictEqual(githubFieldError({ code: 'custom' }), undefined);
	strictEqual(githubFieldError(undefined), undefined);
});

test('a run names the workflow file it came from, and only a real workflow file', () => {
	const sha = 'a'.repeat(40);
	const workflows = parseGhWorkflows(JSON.stringify([{ id: 7, path: '.github/workflows/ci.yml' }, { id: 8, path: 'dynamic/github-code-scanning/codeql' }, { id: 9, path: '.github/workflows/../../x.yml' }]));
	deepStrictEqual([...workflows], [[7, '.github/workflows/ci.yml']]);
	const gh = parseGhRuns(JSON.stringify([
		{ databaseId: 5, name: 'CI', url: 'https://github.com/o/n/actions/runs/5', headBranch: 'main', headSha: sha, workflowDatabaseId: 7 },
		{ databaseId: 6, name: 'CodeQL', url: 'https://github.com/o/n/actions/runs/6', headBranch: 'main', workflowDatabaseId: 8 },
	]), 'main', workflows);
	strictEqual(gh[0].workflowPath, '.github/workflows/ci.yml');
	strictEqual(gh[0].sha, sha);
	strictEqual(gh[1].workflowPath, undefined);
	const api = parseApiRuns(JSON.stringify({ workflow_runs: [{ id: 5, html_url: 'https://github.com/o/n/actions/runs/5', head_branch: 'feat/x', path: '.github/workflows/release.yaml', head_sha: 'nope' }] }));
	strictEqual(api[0].workflowPath, '.github/workflows/release.yaml');
	strictEqual(api[0].sha, undefined);
	strictEqual(workflowFileUrl('o/n', gh[0]), `https://github.com/o/n/blob/${sha}/.github/workflows/ci.yml`);
	strictEqual(workflowFileUrl('o/n', api[0]), 'https://github.com/o/n/blob/feat/x/.github/workflows/release.yaml');
	strictEqual(workflowPath('.github/workflows/sub/x.yml'), undefined);
	strictEqual(workflowPath('.github/workflows/x.txt'), undefined);
});

test('a watched run reads alike from gh and from the API', () => {
	deepStrictEqual(parseWatchedRun(JSON.stringify({ status: 'in_progress', conclusion: '', displayTitle: 'Fix', name: 'CI', url: 'https://github.com/o/r/actions/runs/1' })),
		{ state: 'running', title: 'Fix', url: 'https://github.com/o/r/actions/runs/1' });
	deepStrictEqual(parseWatchedRun(JSON.stringify({ status: 'completed', conclusion: 'failure', display_title: 'Fix', html_url: 'https://github.com/o/r/actions/runs/1' })),
		{ state: 'failure', title: 'Fix', url: 'https://github.com/o/r/actions/runs/1' });
	deepStrictEqual(parseWatchedRun(JSON.stringify({ status: 'completed', conclusion: 'success', name: 'CI', url: 'javascript:alert(1)' })), { state: 'success', title: 'CI' });
	strictEqual(parseWatchedRun('[]'), undefined);
	strictEqual(parseWatchedRun('not json'), undefined);
	strictEqual(parseWatchedRun('{}'), undefined);
});

test('run watch keys, in flight, ended text', () => {
	strictEqual(runWatchKey('Owner/Repo', 42), 'owner/repo#42');
	strictEqual(runInFlight('running'), true);
	strictEqual(runInFlight('queued'), true);
	strictEqual(runInFlight('success'), false);
	strictEqual(runEndedText('failure'), 'Failed.');
	strictEqual(runEndedText('other'), 'Finished.');
});

test('runsForPullRequest: the newest run per workflow of the pull request, finished ones included', () => {
	const run = (id: number, branch: string, event: string, name: string, workflowPath?: string, sha?: string): GithubRun =>
		({ id, name, title: 't', url: 'u', branch, event, state: 'success', updatedAt: '', ...(workflowPath ? { workflowPath } : {}), ...(sha ? { sha } : {}) });
	const runs = [
		run(5, 'feat', 'pull_request', 'Tests', '.github/workflows/test.yml'),
		run(4, 'feat', 'push', 'Tests', '.github/workflows/test.yml'),
		run(3, 'main', 'push', 'Build', '.github/workflows/build.yml'),
		run(2, 'feat', 'push', 'Lint'),
		run(1, 'feat', 'push', 'Lint'),
	];
	deepStrictEqual(runsForPullRequest('o/r', { branch: 'feat' }, runs).map(r => r.id), [5, 2]);
	deepStrictEqual(runsForPullRequest('o/r', { branch: 'feat', headRepo: 'O/R' }, runs).map(r => r.id), [5, 2]);
	// A fork's branch name is not the base repository's: only pull_request runs are its.
	deepStrictEqual(runsForPullRequest('o/r', { branch: 'feat', headRepo: 'fork/r' }, runs).map(r => r.id), [5]);
	deepStrictEqual(runsForPullRequest('o/r', { branch: '' }, runs), []);
});

test('runsForPullRequest: a release or a manual run on the branch is not the pull request\'s (reported)', () => {
	const head = 'a'.repeat(40), old = 'b'.repeat(40);
	const run = (id: number, event: string, name: string, sha: string): GithubRun =>
		({ id, name, title: 't', url: 'u', branch: 'trunk', event, state: 'success', updatedAt: '', workflowPath: `.github/workflows/${name}.yml`, sha });
	const runs = [
		run(9, 'pull_request', 'test', head),
		run(8, 'workflow_run', 'release-production', head),
		run(7, 'workflow_dispatch', 'db-operations', old),
		run(6, 'schedule', 'nightly', head),
		run(5, 'push', 'lint', old),
		run(4, 'pull_request', 'build', old),
	];
	// Without the head commit: pull_request and push runs only.
	deepStrictEqual(runsForPullRequest('o/r', { branch: 'trunk' }, runs).map(r => r.id), [9, 5, 4]);
	// With it: only the runs on that commit.
	deepStrictEqual(runsForPullRequest('o/r', { branch: 'trunk', headSha: head.toUpperCase() }, runs).map(r => r.id), [9]);
});

test('the head commit of a pull request is read from gh and the API', () => {
	const sha = 'c'.repeat(40);
	strictEqual(parseGhPullRequests(JSON.stringify([{ number: 1, url: 'https://github.com/o/r/pull/1', headRefName: 'x', headRefOid: sha }]))[0].headSha, sha);
	strictEqual(parseApiPullRequests(JSON.stringify([{ number: 1, html_url: 'https://github.com/o/r/pull/1', head: { ref: 'x', sha } }]))[0].headSha, sha);
	strictEqual(parseGhPullRequests(JSON.stringify([{ number: 1, url: 'https://github.com/o/r/pull/1', headRefName: 'x', headRefOid: 'nope' }]))[0].headSha, undefined);
});

test('mergedPullRequest: only a merged pull request whose head is the current commit', () => {
	const sha = 'a'.repeat(40);
	const gh = JSON.stringify([
		{ number: 3, url: 'https://github.com/o/r/pull/3', headRefName: 'feat', headRefOid: 'b'.repeat(40), headRepository: { nameWithOwner: 'o/r' } },
		{ number: 5, url: 'https://github.com/o/r/pull/5', headRefName: 'feat', headRefOid: sha, headRepository: { nameWithOwner: 'o/r' } },
	]);
	deepStrictEqual(mergedPullRequest(gh, 'feat', sha, 'o/r'), { number: 5, url: 'https://github.com/o/r/pull/5' });
	strictEqual(mergedPullRequest(gh, 'feat', 'c'.repeat(40), 'o/r'), undefined, 'a commit after the merge offers again');
	strictEqual(mergedPullRequest(gh, 'other', sha), undefined);
	strictEqual(mergedPullRequest(gh, 'feat', sha, 'fork/r'), undefined, 'another fork\'s branch of the same name');
	const api = JSON.stringify([
		{ number: 8, html_url: 'https://github.com/o/r/pull/8', merged_at: null, head: { ref: 'feat', sha, repo: { full_name: 'o/r' } } },
		{ number: 9, html_url: 'https://github.com/o/r/pull/9', merged_at: '2026-11-12T10:00:00Z', head: { ref: 'feat', sha, repo: { full_name: 'o/r' } } },
	]);
	deepStrictEqual(mergedPullRequest(api, 'feat', sha, 'o/r'), { number: 9, url: 'https://github.com/o/r/pull/9' }, 'closed without merge is skipped');
	strictEqual(mergedPullRequest('not json', 'feat', sha), undefined);
});

test('your pull requests: a login read strictly, compared without case', () => {
	strictEqual(githubLogin(' DenisDavydov\n'), 'DenisDavydov');
	strictEqual(githubLogin('-bad'), undefined);
	strictEqual(githubLogin('a'.repeat(40)), undefined);
	strictEqual(githubLogin('[x](command:y)'), undefined);
	strictEqual(isOwnPullRequest({ author: 'denisdavydov' }, 'DenisDavydov'), true);
	strictEqual(isOwnPullRequest({ author: '' }, ''), false);
	strictEqual(isOwnPullRequest({ author: 'me' }, undefined), false);
});

test('a run names who started it, and your own runs are told apart', () => {
	const actors = parseGhRunActors(JSON.stringify([{ id: 1, actor: 'DenisDavydov' }, { id: 2, actor: 'dependabot[bot]' }, { id: 3, actor: '<b>x</b>' }, { id: 'x', actor: 'a' }]));
	deepStrictEqual([...actors], [[1, 'DenisDavydov'], [2, 'dependabot[bot]']]);
	const runs = parseGhRuns(JSON.stringify([
		{ databaseId: 1, url: 'https://github.com/o/r/actions/runs/1', status: 'completed', conclusion: 'success' },
		{ databaseId: 3, url: 'https://github.com/o/r/actions/runs/3', status: 'completed', conclusion: 'success' },
	]), undefined, undefined, actors);
	strictEqual(runs[0].actor, 'DenisDavydov');
	strictEqual(runs[1].actor, undefined);
	const api = parseApiRuns(JSON.stringify({ workflow_runs: [
		{ id: 5, html_url: 'https://github.com/o/r/actions/runs/5', actor: { login: 'alice' }, triggering_actor: { login: 'bob' } },
		{ id: 6, html_url: 'https://github.com/o/r/actions/runs/6', actor: { login: 'alice' } },
	] }));
	deepStrictEqual(api.map(r => r.actor), ['bob', 'alice']);
	strictEqual(isOwnRun({ actor: 'denisdavydov' }, 'DenisDavydov'), true);
	strictEqual(isOwnRun({ actor: 'alice' }, 'DenisDavydov'), false);
	strictEqual(isOwnRun({}, 'DenisDavydov'), false);
	strictEqual(isOwnRun({ actor: 'alice' }, undefined), false);
});
