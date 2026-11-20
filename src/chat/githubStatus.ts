/**
 * The composer's GitHub tab: pull requests and Actions runs of the repository
 * the conversation's working folder belongs to. Reading `gh`'s JSON and the REST
 * API's into one shape, and choosing which remote names the repository. Leaf
 * module, under test: no `vscode`, no relative value imports.
 *
 * Three sources, tried in order by the host (`chatView.ts`, `_githubStatus`):
 * the `gh` CLI (signed in), VS Code's own GitHub sign-in (`authentication`,
 * silent — never prompts), and the public API without a token (public
 * repositories only, 60 requests an hour per address).
 */

export type GithubSource = 'gh' | 'vscode' | 'public';

export interface GithubCheckSummary {
	readonly passed: number;
	readonly failed: number;
	readonly pending: number;
}

export interface GithubPullRequest {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly author: string;
	readonly branch: string;
	/** The branch it merges into (`gh`'s `baseRefName`, the API's `base.ref`). */
	readonly base?: string;
	/** Repository containing the head branch (forks may reuse branch names). */
	readonly headRepo?: string;
	/** The head commit (`gh`'s `headRefOid`, the API's `head.sha`): which runs are this pull request's. */
	readonly headSha?: string;
	readonly draft: boolean;
	/** ISO time of the last update. */
	readonly updatedAt: string;
	/** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty (only `gh` says). */
	readonly review: string;
	/** Only `gh` reports checks per pull request; absent from the API's list. */
	readonly checks?: GithubCheckSummary;
	/** Its head is the working folder's branch. */
	readonly current?: boolean;
	/** GitHub reports a merge conflict with the base branch (`mergeable: CONFLICTING` or state `DIRTY`). */
	readonly conflict?: true;
	/**
	 * GitHub says it can be merged now: mergeable, not a draft, and its merge state
	 * is `CLEAN`, `UNSTABLE` or `HAS_HOOKS` (branch protection satisfied). Absent while
	 * GitHub is still computing it (`UNKNOWN`), when it is blocked, behind, or conflicting.
	 */
	readonly mergeReady?: true;
}

/** How a pull request is merged: a merge commit, squashed, or rebased. */
export type GithubMergeMethod = 'merge' | 'squash' | 'rebase';
export const githubMergeMethods: readonly GithubMergeMethod[] = ['merge', 'squash', 'rebase'];

export type GithubRunState = 'success' | 'failure' | 'running' | 'queued' | 'cancelled' | 'skipped' | 'other';

export interface GithubRun {
	readonly id: number;
	readonly name: string;
	readonly title: string;
	readonly url: string;
	readonly branch: string;
	readonly event: string;
	readonly state: GithubRunState;
	readonly updatedAt: string;
	readonly current?: boolean;
	/**
	 * The workflow file the run came from (`.github/workflows/ci.yml`), only when
	 * it has that shape: a run of a dynamic workflow (code scanning, Pages) has
	 * no file in the repository, and the path is the network's, so nothing else
	 * is passed on to be opened.
	 */
	readonly workflowPath?: string;
	/** The commit the run ran on, for a link to the workflow file as it was then. */
	readonly sha?: string;
	/** Who started it: `triggering_actor` (a re-run's own), else `actor`. */
	readonly actor?: string;
}

export interface GithubStatus {
	readonly repo: string;
	readonly source: GithubSource;
	readonly branch?: string;
	/** The name `branch` is pushed under, when it tracks another one (`local-work` → `origin/remote-work`). */
	readonly headBranch?: string;
	readonly pushRepo?: string;
	readonly prs: readonly GithubPullRequest[];
	readonly runs: readonly GithubRun[];
	/** Runs could not be read (Actions off, no access) while the pull requests could. */
	readonly runsError?: string;
	/** The repository's default branch, the base a new pull request is opened against. */
	readonly defaultBranch?: string;
	/** The working folder's branch has an upstream on the remote (a pull request needs it pushed). */
	readonly published?: boolean;
	/**
	 * Its upstream was deleted on the remote (`[gone]`): typically the branch of a pull request
	 * already merged, so there is nothing left to open a pull request for.
	 */
	readonly upstreamGone?: boolean;
	/** The branch's last commit subject: the title a new pull request starts with. */
	readonly suggestedTitle?: string;
	/**
	 * A pull request from this branch already merged, whose head is the branch's
	 * current commit: there is nothing new to open a pull request for. A commit
	 * made since brings the offer back.
	 */
	readonly mergedPr?: GithubMergedPr;
	/** The signed-in GitHub login (`gh api user`, or VS Code's GitHub account): its login is shown in blue on its pull requests. */
	readonly viewer?: string;
	/**
	 * The merge methods the repository allows, present only when the signed-in
	 * account may push to it: what the Merge button offers.
	 */
	readonly mergeMethods?: readonly GithubMergeMethod[];
}

/** A GitHub login as GitHub allows it, or undefined. */
export function githubLogin(value: unknown): string | undefined {
	const s = typeof value === 'string' ? value.trim() : '';
	return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s) ? s : undefined;
}

/** A run's actor: a login, or an app's bot account (`dependabot[bot]`). */
function actorLogin(value: unknown): string | undefined {
	const s = typeof value === 'string' ? value.trim() : '';
	return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(s) ? s : undefined;
}

/** Whether `viewer` wrote the pull request (logins compare without case). */
export function isOwnPullRequest(pr: Pick<GithubPullRequest, 'author'>, viewer: string | undefined): boolean {
	return !!viewer && !!pr.author && pr.author.toLowerCase() === viewer.toLowerCase();
}

/** Whether the signed-in account started this run (case-insensitive, as GitHub logins are). */
export function isOwnRun(run: Pick<GithubRun, 'actor'>, viewer: string | undefined): boolean {
	return !!viewer && !!run.actor && run.actor.toLowerCase() === viewer.toLowerCase();
}

/**
 * `gh run list --json` has no actor field, so the gh path reads who started each run
 * from the REST list through `gh api` with this filter, and joins it by id.
 */
export const ghRunActorsJq = '[.workflow_runs[] | {id, actor: (.triggering_actor.login // .actor.login)}]';

/** The output of `ghRunActorsJq`: run id → login, only well-formed logins kept. */
export function parseGhRunActors(json: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const id = num(raw?.id);
		const login = actorLogin(raw?.actor);
		if (id && login) { out.set(id, login); }
	}
	return out;
}

/** A merged pull request of the working folder's branch. */
export interface GithubMergedPr {
	readonly number: number;
	readonly url: string;
}

/** What `gh pr list --state merged --json` is asked for. */
export const ghMergedFields = 'number,url,headRefName,headRefOid,headRepository,headRepositoryOwner';

/**
 * The merged pull request whose head is `headSha` on `branch` (in `pushRepo`
 * when known), from `gh pr list --state merged --json` or the API's
 * `pulls?state=closed&head=…`. Only an exact head match counts: a branch with
 * commits after the merge has something new to offer.
 */
export function mergedPullRequest(json: string, branch: string, headSha: string, pushRepo?: string): GithubMergedPr | undefined {
	let parsed: unknown;
	try { parsed = JSON.parse(json); } catch { return undefined; }
	if (!Array.isArray(parsed) || !/^[0-9a-f]{40}$/i.test(headSha)) { return undefined; }
	for (const raw of parsed.slice(0, githubListLimit) as Record<string, unknown>[]) {
		const head = raw?.head as Record<string, unknown> | undefined;
		// The API lists closed pull requests too; only a merged one counts.
		if (head && !raw.merged_at) { continue; }
		const ref = text(head ? head.ref : raw?.headRefName, 250);
		const sha = text(head ? head.sha : raw?.headRefOid, 64);
		const repository = (head ? head.repo : raw?.headRepository) as Record<string, unknown> | undefined;
		const owner = text((raw?.headRepositoryOwner as Record<string, unknown> | undefined)?.login, 100);
		const repo = text(repository?.full_name ?? repository?.nameWithOwner, 250) || (owner && repository?.name ? `${owner}/${text(repository.name, 100)}` : '');
		if (ref !== branch || sha.toLowerCase() !== headSha.toLowerCase()) { continue; }
		if (pushRepo && repo && repo.toLowerCase() !== pushRepo.toLowerCase()) { continue; }
		const number = num(raw.number);
		const url = httpsUrl(head ? raw.html_url : raw.url);
		if (number && url) { return { number, url }; }
	}
	return undefined;
}

/**
 * The Actions runs shown under a pull request: the newest of each workflow (the list is newest
 * first) among the runs that are its own, the way a pull request's checks read on GitHub.
 *
 * Its own means a `pull_request` / `pull_request_target` run, or a `push` run, on its head
 * branch — and on its head commit when that is known. Matching the branch alone listed every
 * run that ever touched it: a `workflow_run` release and a `workflow_dispatch` job from hours
 * before the pull request was opened, under a pull request whose tests were just starting
 * (reported). A run names its branch and not the repository the branch is in, so for a pull
 * request from a fork only `pull_request` runs count — a push to a branch of the same name
 * here is not its run.
 */
export function runsForPullRequest(repo: string, pr: Pick<GithubPullRequest, 'branch' | 'headRepo' | 'headSha'>, runs: readonly GithubRun[]): GithubRun[] {
	if (!pr.branch) { return []; }
	const fork = !!pr.headRepo && pr.headRepo.toLowerCase() !== repo.toLowerCase();
	const head = pr.headSha?.toLowerCase();
	const seen = new Set<string>();
	const out: GithubRun[] = [];
	for (const run of runs) {
		if (run.branch !== pr.branch) { continue; }
		const prEvent = run.event.startsWith('pull_request');
		if (!prEvent && (fork || run.event !== 'push')) { continue; }
		if (head && run.sha && run.sha.toLowerCase() !== head) { continue; }
		const workflow = run.workflowPath ?? run.name;
		if (seen.has(workflow)) { continue; }
		seen.add(workflow);
		out.push(run);
	}
	return out;
}

/** A pull request just opened from the GitHub tab. */
export interface GithubCreatedPr {
	readonly number: number;
	readonly url: string;
}

/**
 * Whether the tab offers to open a pull request for the working folder's
 * branch: one is checked out, it is not the default branch, and no open pull
 * request has it as its head, and its remote branch was not deleted.
 */
export function canOfferPullRequest(status: GithubStatus): boolean {
	const branch = status.headBranch ?? status.branch;
	if (!branch || !status.defaultBranch || branch === status.defaultBranch) { return false; }
	// A merged pull request's branch, deleted on the remote: a disabled "Create pull request" stayed
	// there for good, with nothing the user could do from it (reported). Publishing it again in the
	// Branches window brings the offer back.
	if (status.upstreamGone) { return false; }
	// Merged with its remote branch kept: the offer stayed after the merge (reported).
	if (status.mergedPr) { return false; }
	const repo = (status.pushRepo ?? status.repo).toLowerCase();
	return !status.prs.some(pr => pr.branch === branch && (pr.headRepo ?? status.repo).toLowerCase() === repo);
}

/**
 * The `head` of a new pull request: the bare branch when it lives in the
 * repository the tab shows, `owner:branch` when it was pushed to a fork.
 */
export function pullRequestHead(repo: string, pushRepo: string | undefined, branch: string): string {
	if (!pushRepo || pushRepo.toLowerCase() === repo.toLowerCase()) { return branch; }
	return `${pushRepo.split('/')[0]}:${branch}`;
}

/** A pull request's body from the branch's commit subjects, newest last. */
export function pullRequestBody(subjects: readonly string[]): string {
	const lines = subjects.map(s => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean).slice(-50);
	return lines.length > 1 ? lines.map(l => `- ${l}`).join('\n') : '';
}

/** A title the user typed: one line, not empty, at most 256 characters as GitHub allows. */
export function pullRequestTitle(typed: unknown): string | undefined {
	if (typeof typed !== 'string') { return undefined; }
	const title = typed.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return title && [...title].length <= 256 ? title : undefined;
}

/** `POST /repos/{o}/{n}/pulls`'s answer, or the URL `gh pr create` prints. */
export function parseCreatedPr(output: string): GithubCreatedPr | undefined {
	const trimmed = output.trim();
	if (trimmed.startsWith('{')) {
		try {
			const raw = JSON.parse(trimmed) as Record<string, unknown>;
			const number = num(raw.number);
			const url = httpsUrl(raw.html_url);
			return number && url ? { number, url } : undefined;
		} catch { return undefined; }
	}
	const m = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(trimmed);
	return m ? { number: Number(m[1]), url: m[0] } : undefined;
}

/** What `gh pr list --json` is asked for. */
export const ghPrFields = 'number,title,url,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isDraft,updatedAt,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus';
/** What `gh repo view --json` is asked for: the default branch, and whether and how the viewer may merge. */
export const ghRepoFields = 'defaultBranchRef,viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed';
/** What `gh run list --json` is asked for. */
export const ghRunFields = 'databaseId,name,displayTitle,url,headBranch,headSha,event,status,conclusion,updatedAt,workflowDatabaseId';
/** What `gh workflow list --json` is asked for: `gh run list` names a run's workflow by id only. */
export const ghWorkflowFields = 'id,path';

/** A workflow file's path as GitHub reports it, kept only when it is a file directly in `.github/workflows`. */
export function workflowPath(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > 300) { return undefined; }
	return /^\.github\/workflows\/[^/\\\u0000-\u001f\u007f]+\.ya?ml$/i.test(value) ? value : undefined;
}

/** `gh workflow list --json id,path`: workflow id → its file. */
export function parseGhWorkflows(json: string): Map<number, string> {
	const out = new Map<number, string>();
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) { return out; }
	for (const raw of parsed.slice(0, 500) as Record<string, unknown>[]) {
		const id = typeof raw?.id === 'number' && Number.isSafeInteger(raw.id) ? raw.id : undefined;
		const file = workflowPath(raw?.path);
		if (id !== undefined && file) { out.set(id, file); }
	}
	return out;
}

/** The workflow file as it was at the run's commit, on GitHub. */
export function workflowFileUrl(repo: string, run: Pick<GithubRun, 'workflowPath' | 'sha' | 'branch'>): string | undefined {
	if (!run.workflowPath || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { return undefined; }
	const ref = run.sha ?? run.branch;
	if (!ref) { return undefined; }
	return `https://github.com/${repo}/blob/${ref.split('/').map(encodeURIComponent).join('/')}/${run.workflowPath.split('/').map(encodeURIComponent).join('/')}`;
}

export const githubListLimit = 30;
/** How many open pull requests the REST path asks one by one for their mergeability (the list carries none). */
export const githubMergeCheckLimit = 10;

const text = (value: unknown, max = 300): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const httpsUrl = (value: unknown): string => {
	const s = text(value, 2000);
	return /^https:\/\/github\.com\//.test(s) ? s : '';
};
const commitSha = (value: unknown): string | undefined => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function arrayOf(json: string): unknown[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) { throw new Error('Not a list.'); }
	return parsed.slice(0, githubListLimit);
}

/** A check run (`status`/`conclusion`) or a commit status context (`state`), as `gh` mixes them. */
export function summarizeChecks(rollup: unknown): GithubCheckSummary | undefined {
	if (!Array.isArray(rollup) || !rollup.length) { return undefined; }
	let passed = 0, failed = 0, pending = 0;
	for (const c of rollup as Record<string, unknown>[]) {
		const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
		const status = String(c?.status || '').toUpperCase();
		if (status && status !== 'COMPLETED') { pending++; }
		else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)) { passed++; }
		else if (['PENDING', 'EXPECTED', ''].includes(verdict)) { pending++; }
		else { failed++; }
	}
	return { passed, failed, pending };
}

export function runState(status: unknown, conclusion: unknown): GithubRunState {
	const s = String(status ?? '').toLowerCase();
	if (s && s !== 'completed') { return s === 'in_progress' ? 'running' : 'queued'; }
	const c = String(conclusion ?? '').toLowerCase();
	if (c === 'success') { return 'success'; }
	if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') { return 'failure'; }
	if (c === 'cancelled') { return 'cancelled'; }
	if (c === 'skipped') { return 'skipped'; }
	return 'other';
}

export function parseGhPullRequests(json: string, branch?: string): GithubPullRequest[] {
	const out: GithubPullRequest[] = [];
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const number = num(raw?.number);
		const url = httpsUrl(raw?.url);
		if (!number || !url) { continue; }
		const head = text(raw.headRefName, 250);
		const base = text(raw.baseRefName, 250);
		const repository = raw.headRepository as Record<string, unknown> | undefined;
		const owner = text((raw.headRepositoryOwner as Record<string, unknown> | undefined)?.login, 100);
		const name = text(repository?.name, 100);
		const headRepo = text(repository?.nameWithOwner, 250) || (owner && name ? `${owner}/${name}` : '');
		const checks = summarizeChecks(raw.statusCheckRollup);
		const headSha = commitSha(raw.headRefOid);
		const draft = raw.isDraft === true;
		out.push({
			number, url, title: text(raw.title), author: text((raw.author as Record<string, unknown> | undefined)?.login, 100),
			branch: head, draft, updatedAt: text(raw.updatedAt, 40), review: text(raw.reviewDecision, 40),
			...(base ? { base } : {}), ...(headRepo ? { headRepo } : {}), ...(headSha ? { headSha } : {}),
			...(checks ? { checks } : {}), ...(branch && head === branch ? { current: true } : {}),
			...mergeVerdict(raw.mergeable, raw.mergeStateStatus, draft),
		});
	}
	return out;
}

export function parseGhRuns(json: string, branch?: string, workflows?: ReadonlyMap<number, string>, actors?: ReadonlyMap<number, string>): GithubRun[] {
	const out: GithubRun[] = [];
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const id = num(raw?.databaseId);
		const url = httpsUrl(raw?.url);
		if (!id || !url) { continue; }
		const head = text(raw.headBranch, 250);
		const workflowId = num(raw.workflowDatabaseId);
		const file = workflowPath(raw.path) ?? (workflowId !== undefined ? workflows?.get(workflowId) : undefined);
		const sha = commitSha(raw.headSha);
		const actor = actorLogin(raw.actor) ?? actors?.get(id);
		out.push({
			id, url, name: text(raw.name), title: text(raw.displayTitle), branch: head, event: text(raw.event, 40),
			state: runState(raw.status, raw.conclusion), updatedAt: text(raw.updatedAt, 40), ...(branch && head === branch ? { current: true } : {}),
			...(file ? { workflowPath: file } : {}), ...(sha ? { sha } : {}), ...(actor ? { actor } : {}),
		});
	}
	return out;
}

/**
 * Whether a pull request conflicts with its base, and whether GitHub would merge
 * it now. `mergeable` is `gh`'s `MERGEABLE` / `CONFLICTING` / `UNKNOWN`; the merge
 * state is `gh`'s `mergeStateStatus` or the API's `mergeable_state`, any case.
 * `BEHIND`, `BLOCKED`, `DRAFT` and `UNKNOWN` are neither: nothing is said.
 */
export function mergeVerdict(mergeable: unknown, state: unknown, draft: boolean): { conflict?: true; mergeReady?: true } {
	const m = typeof mergeable === 'string' ? mergeable.toUpperCase() : '';
	const s = typeof state === 'string' ? state.toUpperCase() : '';
	if (m === 'CONFLICTING' || s === 'DIRTY') { return { conflict: true }; }
	if (!draft && m === 'MERGEABLE' && (s === 'CLEAN' || s === 'UNSTABLE' || s === 'HAS_HOOKS')) { return { mergeReady: true }; }
	return {};
}

/** Whether a `viewerPermission` (`gh`) lets its account merge. */
const pushPermission = (p: unknown): boolean => typeof p === 'string' && ['WRITE', 'MAINTAIN', 'ADMIN'].includes(p.toUpperCase());

/**
 * The repository's default branch and, when the viewer may push, the merge
 * methods it allows: `gh repo view --json ghRepoFields`, or `GET /repos/{o}/{n}`
 * (whose `allow_*` fields are only sent to some accounts: absent counts as allowed,
 * and GitHub refuses a method it does not allow).
 */
export function parseRepoMerge(json: string): { defaultBranch?: string; mergeMethods?: GithubMergeMethod[] } {
	const raw = JSON.parse(json) as Record<string, unknown>;
	if (!raw || typeof raw !== 'object') { return {}; }
	const gh = 'defaultBranchRef' in raw || 'viewerPermission' in raw;
	const defaultBranch = text(gh ? (raw.defaultBranchRef as Record<string, unknown> | undefined)?.name : raw.default_branch, 250) || undefined;
	const canPush = gh ? pushPermission(raw.viewerPermission) : (raw.permissions as Record<string, unknown> | undefined)?.push === true;
	if (!canPush) { return { ...(defaultBranch ? { defaultBranch } : {}) }; }
	const allowed = (ghKey: string, apiKey: string) => (gh ? raw[ghKey] : raw[apiKey]) !== false;
	const mergeMethods = githubMergeMethods.filter(m => m === 'merge' ? allowed('mergeCommitAllowed', 'allow_merge_commit') : m === 'squash' ? allowed('squashMergeAllowed', 'allow_squash_merge') : allowed('rebaseMergeAllowed', 'allow_rebase_merge'));
	return { ...(defaultBranch ? { defaultBranch } : {}), ...(mergeMethods.length ? { mergeMethods } : {}) };
}

/** A merge method from the view, or undefined. */
export function mergeMethod(value: unknown): GithubMergeMethod | undefined {
	return githubMergeMethods.find(m => m === value);
}

/** `GET /repos/{o}/{n}/pulls?state=open`. */
export function parseApiPullRequests(json: string, branch?: string): GithubPullRequest[] {
	const out: GithubPullRequest[] = [];
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const number = num(raw?.number);
		const url = httpsUrl(raw?.html_url);
		if (!number || !url) { continue; }
		const head = text((raw.head as Record<string, unknown> | undefined)?.ref, 250);
		const headRepo = text(((raw.head as Record<string, unknown> | undefined)?.repo as Record<string, unknown> | undefined)?.full_name, 250);
		const headSha = commitSha((raw.head as Record<string, unknown> | undefined)?.sha);
		const base = text((raw.base as Record<string, unknown> | undefined)?.ref, 250);
		const draft = raw.draft === true;
		// The list carries no `mergeable`; one pull request's own answer (`GET pulls/{n}`) does.
		const mergeable = raw.mergeable === true ? 'MERGEABLE' : raw.mergeable === false ? 'CONFLICTING' : undefined;
		out.push({
			number, url, title: text(raw.title), author: text((raw.user as Record<string, unknown> | undefined)?.login, 100),
			branch: head, draft, updatedAt: text(raw.updated_at, 40), review: '',
			...(base ? { base } : {}), ...(headRepo ? { headRepo } : {}), ...(headSha ? { headSha } : {}),
			...(branch && head === branch ? { current: true } : {}),
			...mergeVerdict(mergeable, raw.mergeable_state, draft),
		});
	}
	return out;
}

/** `GET /repos/{o}/{n}/actions/runs`: `{ workflow_runs: [...] }`. */
export function parseApiRuns(json: string, branch?: string): GithubRun[] {
	const parsed = JSON.parse(json) as { workflow_runs?: unknown };
	if (!Array.isArray(parsed?.workflow_runs)) { throw new Error('Not a run list.'); }
	return parseGhRuns(JSON.stringify((parsed.workflow_runs as Record<string, unknown>[]).map(r => ({
		databaseId: r?.id, name: r?.name, displayTitle: r?.display_title, url: r?.html_url, headBranch: r?.head_branch,
		event: r?.event, status: r?.status, conclusion: r?.conclusion, updatedAt: r?.updated_at, path: r?.path, headSha: r?.head_sha,
		actor: (r?.triggering_actor as Record<string, unknown> | undefined)?.login ?? (r?.actor as Record<string, unknown> | undefined)?.login,
	}))), branch);
}

/**
 * Which remote names the repository: the current branch's upstream remote,
 * then `upstream` (a fork's parent, where its pull requests are), then
 * `origin`, then the first one that is on github.com.
 */
export function pickGithubRemote<R>(remotes: readonly { name: string; url: string }[], parse: (url: string) => R | undefined, upstreamRemote?: string): R | undefined {
	const order = [upstreamRemote, 'upstream', 'origin'];
	for (const name of order) {
		const r = name ? remotes.find(x => x.name === name) : undefined;
		const repo = r && parse(r.url);
		if (repo) { return repo; }
	}
	for (const r of remotes) { const repo = parse(r.url); if (repo) { return repo; } }
	return undefined;
}

/**
 * A REST validation error that names a field and a code but no message — what
 * GitHub sends for a pull request whose head branch is not on the remote
 * (`{ resource: 'PullRequest', field: 'head', code: 'invalid' }`), under the
 * bare top-level "Validation Failed".
 */
export function githubFieldError(error: { field?: unknown; code?: unknown } | undefined): string | undefined {
	if (!error || typeof error.field !== 'string') { return undefined; }
	const code = typeof error.code === 'string' ? error.code : 'invalid';
	if (error.field === 'head' && code === 'invalid') { return 'The branch is not on GitHub. Push it (Branches window → Publish), then try again.'; }
	if (error.field === 'base' && code === 'invalid') { return 'The base branch is not on GitHub.'; }
	return `Validation failed: ${error.field} is ${code.replace(/_/g, ' ')}.`;
}

/**
 * An Actions run being watched from the GitHub tab's bell: the key it is known
 * by in the host and the view (`owner/name#id`, the repository's case folded,
 * since GitHub's is not significant).
 */
export function runWatchKey(repo: string, id: number): string {
	return `${repo.toLowerCase()}#${id}`;
}

/** Fields `gh run view` is asked for when a watched run is polled. */
export const ghWatchedRunFields = 'status,conclusion,displayTitle,name,url';

/**
 * One run as `gh run view --json` (`displayTitle`, `url`) or the REST API
 * (`display_title`, `html_url`) describes it; `undefined` for anything else.
 */
export function parseWatchedRun(json: string): { state: GithubRunState; title: string; url?: string } | undefined {
	let raw: Record<string, unknown>;
	try { raw = JSON.parse(json) as Record<string, unknown>; } catch { return undefined; }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.status !== 'string') { return undefined; }
	const url = httpsUrl(raw.url) || httpsUrl(raw.html_url);
	return {
		state: runState(raw.status, raw.conclusion),
		title: text(raw.displayTitle) || text(raw.display_title) || text(raw.name),
		...(url ? { url } : {}),
	};
}

/** Whether a run is still to finish: what the bell is offered for, and what keeps it being polled. */
export function runInFlight(state: GithubRunState): boolean {
	return state === 'running' || state === 'queued';
}

/** The notification's line for a run that has ended. */
export function runEndedText(state: GithubRunState): string {
	switch (state) {
		case 'success': return 'Finished successfully.';
		case 'failure': return 'Failed.';
		case 'cancelled': return 'Was cancelled.';
		case 'skipped': return 'Was skipped.';
		default: return 'Finished.';
	}
}
