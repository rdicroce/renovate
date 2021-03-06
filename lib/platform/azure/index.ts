import is from '@sindresorhus/is';
import {
  GitPullRequest,
  GitPullRequestCommentThread,
  GitPullRequestMergeStrategy,
  PullRequestStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import {
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
} from '../../constants/error-messages';
import { PLATFORM_TYPE_AZURE } from '../../constants/platforms';
import { logger } from '../../logger';
import { BranchStatus, PrState } from '../../types';
import * as git from '../../util/git';
import * as hostRules from '../../util/host-rules';
import { sanitize } from '../../util/sanitize';
import { ensureTrailingSlash } from '../../util/url';
import {
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueResult,
  FindPRConfig,
  Issue,
  PlatformParams,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
  VulnerabilityAlert,
} from '../common';
import { smartTruncate } from '../utils/pr-body';
import * as azureApi from './azure-got-wrapper';
import * as azureHelper from './azure-helper';
import { AzurePr } from './types';
import {
  getBranchNameWithoutRefsheadsPrefix,
  getNewBranchName,
  getRenovatePRFormat,
} from './util';

interface Config {
  repoForceRebase: boolean;
  mergeMethod: GitPullRequestMergeStrategy;
  owner: string;
  repoId: string;
  project: string;
  prList: AzurePr[];
  fileList: null;
  repository: string;
  defaultBranch: string;
}

interface User {
  id: string;
  name: string;
}

let config: Config = {} as any;

const defaults: {
  endpoint?: string;
  hostType: string;
} = {
  hostType: PLATFORM_TYPE_AZURE,
};

export function initPlatform({
  endpoint,
  token,
  username,
  password,
}: PlatformParams): Promise<PlatformResult> {
  if (!endpoint) {
    throw new Error('Init: You must configure an Azure DevOps endpoint');
  }
  if (!token && !(username && password)) {
    throw new Error(
      'Init: You must configure an Azure DevOps token, or a username and password'
    );
  }
  // TODO: Add a connection check that endpoint/token combination are valid
  const res = {
    endpoint: ensureTrailingSlash(endpoint),
  };
  defaults.endpoint = res.endpoint;
  azureApi.setEndpoint(res.endpoint);
  const platformConfig: PlatformResult = {
    endpoint: defaults.endpoint,
  };
  return Promise.resolve(platformConfig);
}

export async function getRepos(): Promise<string[]> {
  logger.debug('Autodiscovering Azure DevOps repositories');
  const azureApiGit = await azureApi.gitApi();
  const repos = await azureApiGit.getRepositories();
  return repos.map((repo) => `${repo.project.name}/${repo.name}`);
}

export async function getJsonFile(fileName: string): Promise<any | null> {
  try {
    const json = await azureHelper.getFile(
      config.repoId,
      fileName,
      config.defaultBranch
    );
    return JSON.parse(json);
  } catch (err) /* istanbul ignore next */ {
    return null;
  }
}

export async function initRepo({
  repository,
  localDir,
  optimizeForDisabled,
}: RepoParams): Promise<RepoResult> {
  logger.debug(`initRepo("${repository}")`);
  config = { repository } as Config;
  const azureApiGit = await azureApi.gitApi();
  const repos = await azureApiGit.getRepositories();
  const names = azureHelper.getProjectAndRepo(repository);
  const repo = repos.filter(
    (c) =>
      c.name.toLowerCase() === names.repo.toLowerCase() &&
      c.project.name.toLowerCase() === names.project.toLowerCase()
  )[0];
  logger.debug({ repositoryDetails: repo }, 'Repository details');
  // istanbul ignore if
  if (!repo.defaultBranch) {
    logger.debug('Repo is empty');
    throw new Error(REPOSITORY_EMPTY);
  }
  config.repoId = repo.id;
  config.project = repo.project.name;
  config.owner = '?owner?';
  logger.debug(`${repository} owner = ${config.owner}`);
  const defaultBranch = repo.defaultBranch.replace('refs/heads/', '');
  config.defaultBranch = defaultBranch;
  logger.debug(`${repository} default branch = ${defaultBranch}`);
  config.mergeMethod = await azureHelper.getMergeMethod(repo.id, names.project);
  config.repoForceRebase = false;

  if (optimizeForDisabled) {
    interface RenovateConfig {
      enabled: boolean;
    }

    const renovateConfig: RenovateConfig = await getJsonFile('renovate.json');
    if (renovateConfig && renovateConfig.enabled === false) {
      throw new Error(REPOSITORY_DISABLED);
    }
  }

  const [projectName, repoName] = repository.split('/');
  const opts = hostRules.find({
    hostType: defaults.hostType,
    url: defaults.endpoint,
  });
  const manualUrl =
    defaults.endpoint +
    `${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`;
  const url = repo.remoteUrl || manualUrl;
  await git.initRepo({
    ...config,
    localDir,
    url,
    extraCloneOpts: azureHelper.getStorageExtraCloneOpts(opts),
    gitAuthorName: global.gitAuthor?.name,
    gitAuthorEmail: global.gitAuthor?.email,
  });
  const repoConfig: RepoResult = {
    defaultBranch,
    isFork: false,
  };
  return repoConfig;
}

export function getRepoForceRebase(): Promise<boolean> {
  return Promise.resolve(config.repoForceRebase === true);
}

export async function getPrList(): Promise<AzurePr[]> {
  logger.debug('getPrList()');
  if (!config.prList) {
    const azureApiGit = await azureApi.gitApi();
    let prs: GitPullRequest[] = [];
    let fetchedPrs: GitPullRequest[];
    let skip = 0;
    do {
      fetchedPrs = await azureApiGit.getPullRequests(
        config.repoId,
        { status: 4 },
        config.project,
        0,
        skip,
        100
      );
      prs = prs.concat(fetchedPrs);
      skip += 100;
    } while (fetchedPrs.length > 0);

    config.prList = prs.map(getRenovatePRFormat);
    logger.debug({ length: config.prList.length }, 'Retrieved Pull Requests');
  }
  return config.prList;
}

export async function getPr(pullRequestId: number): Promise<Pr | null> {
  logger.debug(`getPr(${pullRequestId})`);
  if (!pullRequestId) {
    return null;
  }
  const azurePr = (await getPrList()).find(
    (item) => item.number === pullRequestId
  );

  if (!azurePr) {
    return null;
  }

  const azureApiGit = await azureApi.gitApi();
  const labels = await azureApiGit.getPullRequestLabels(
    config.repoId,
    pullRequestId
  );

  azurePr.labels = labels
    .filter((label) => label.active)
    .map((label) => label.name);
  azurePr.hasReviewers = is.nonEmptyArray(azurePr.reviewers);
  return azurePr;
}

export async function findPr({
  branchName,
  prTitle,
  state = PrState.All,
}: FindPRConfig): Promise<Pr | null> {
  let prsFiltered: Pr[] = [];
  try {
    const prs = await getPrList();

    prsFiltered = prs.filter(
      (item) => item.sourceRefName === getNewBranchName(branchName)
    );

    if (prTitle) {
      prsFiltered = prsFiltered.filter((item) => item.title === prTitle);
    }

    switch (state) {
      case PrState.All:
        // no more filter needed, we can go further...
        break;
      case PrState.NotOpen:
        prsFiltered = prsFiltered.filter((item) => item.state !== PrState.Open);
        break;
      default:
        prsFiltered = prsFiltered.filter((item) => item.state === state);
        break;
    }
  } catch (err) {
    logger.error({ err }, 'findPr error');
  }
  if (prsFiltered.length === 0) {
    return null;
  }
  return prsFiltered[0];
}

export async function getBranchPr(branchName: string): Promise<Pr | null> {
  logger.debug(`getBranchPr(${branchName})`);
  const existingPr = await findPr({
    branchName,
    state: PrState.Open,
  });
  return existingPr ? getPr(existingPr.number) : null;
}

export async function getBranchStatusCheck(
  branchName: string,
  context: string
): Promise<BranchStatus> {
  logger.trace(`getBranchStatusCheck(${branchName}, ${context})`);
  const azureApiGit = await azureApi.gitApi();
  const branch = await azureApiGit.getBranch(
    config.repoId,
    getBranchNameWithoutRefsheadsPrefix(branchName)!
  );
  if (branch.aheadCount === 0) {
    return BranchStatus.green;
  }
  return BranchStatus.yellow;
}

export async function getBranchStatus(
  branchName: string,
  requiredStatusChecks: string[]
): Promise<BranchStatus> {
  logger.debug(`getBranchStatus(${branchName})`);
  if (!requiredStatusChecks) {
    // null means disable status checks, so it always succeeds
    return BranchStatus.green;
  }
  if (requiredStatusChecks.length) {
    // This is Unsupported
    logger.warn({ requiredStatusChecks }, `Unsupported requiredStatusChecks`);
    return BranchStatus.red;
  }
  const branchStatusCheck = await getBranchStatusCheck(branchName, null);
  return branchStatusCheck;
}

export async function createPr({
  sourceBranch,
  targetBranch,
  prTitle: title,
  prBody: body,
  labels,
  draftPR = false,
  platformOptions,
}: CreatePRConfig): Promise<Pr> {
  const sourceRefName = getNewBranchName(sourceBranch);
  const targetRefName = getNewBranchName(targetBranch);
  const description = azureHelper.max4000Chars(sanitize(body));
  const azureApiGit = await azureApi.gitApi();
  const workItemRefs = [
    {
      id: platformOptions?.azureWorkItemId?.toString(),
    },
  ];
  let pr: GitPullRequest = await azureApiGit.createPullRequest(
    {
      sourceRefName,
      targetRefName,
      title,
      description,
      workItemRefs,
      isDraft: draftPR,
    },
    config.repoId
  );
  if (platformOptions?.azureAutoComplete) {
    pr = await azureApiGit.updatePullRequest(
      {
        autoCompleteSetBy: {
          id: pr.createdBy.id,
        },
        completionOptions: {
          mergeStrategy: config.mergeMethod,
          deleteSourceBranch: true,
        },
      },
      config.repoId,
      pr.pullRequestId
    );
  }
  await Promise.all(
    labels.map((label) =>
      azureApiGit.createPullRequestLabel(
        {
          name: label,
        },
        config.repoId,
        pr.pullRequestId
      )
    )
  );
  return getRenovatePRFormat(pr);
}

export async function updatePr({
  number: prNo,
  prTitle: title,
  prBody: body,
  state,
}: UpdatePrConfig): Promise<void> {
  logger.debug(`updatePr(${prNo}, ${title}, body)`);

  const azureApiGit = await azureApi.gitApi();
  const objToUpdate: GitPullRequest = {
    title,
  };

  if (body) {
    objToUpdate.description = azureHelper.max4000Chars(sanitize(body));
  }

  if (state === PrState.Open) {
    await azureApiGit.updatePullRequest(
      { status: PullRequestStatus.Active },
      config.repoId,
      prNo
    );
  } else if (state === PrState.Closed) {
    objToUpdate.status = PullRequestStatus.Abandoned;
  }

  await azureApiGit.updatePullRequest(objToUpdate, config.repoId, prNo);
}

export async function ensureComment({
  number,
  topic,
  content,
}: EnsureCommentConfig): Promise<boolean> {
  logger.debug(`ensureComment(${number}, ${topic}, content)`);
  const header = topic ? `### ${topic}\n\n` : '';
  const body = `${header}${sanitize(content)}`;
  const azureApiGit = await azureApi.gitApi();

  const threads = await azureApiGit.getThreads(config.repoId, number);
  let threadIdFound = null;
  let commentIdFound = null;
  let commentNeedsUpdating = false;
  threads.forEach((thread) => {
    const firstCommentContent = thread.comments[0].content;
    if (
      (topic && firstCommentContent?.startsWith(header)) ||
      (!topic && firstCommentContent === body)
    ) {
      threadIdFound = thread.id;
      commentIdFound = thread.comments[0].id;
      commentNeedsUpdating = firstCommentContent !== body;
    }
  });

  if (!threadIdFound) {
    await azureApiGit.createThread(
      {
        comments: [{ content: body, commentType: 1, parentCommentId: 0 }],
        status: 1,
      },
      config.repoId,
      number
    );
    logger.info(
      { repository: config.repository, issueNo: number, topic },
      'Comment added'
    );
  } else if (commentNeedsUpdating) {
    await azureApiGit.updateComment(
      {
        content: body,
      },
      config.repoId,
      number,
      threadIdFound,
      commentIdFound
    );
    logger.debug(
      { repository: config.repository, issueNo: number, topic },
      'Comment updated'
    );
  } else {
    logger.debug(
      { repository: config.repository, issueNo: number, topic },
      'Comment is already update-to-date'
    );
  }

  return true;
}

export async function ensureCommentRemoval({
  number: issueNo,
  topic,
  content,
}: EnsureCommentRemovalConfig): Promise<void> {
  logger.debug(
    `Ensuring comment "${topic || content}" in #${issueNo} is removed`
  );

  const azureApiGit = await azureApi.gitApi();
  const threads = await azureApiGit.getThreads(config.repoId, issueNo);

  const byTopic = (thread: GitPullRequestCommentThread): boolean =>
    thread.comments[0].content.startsWith(`### ${topic}\n\n`);
  const byContent = (thread: GitPullRequestCommentThread): boolean =>
    thread.comments[0].content.trim() === content;

  let threadIdFound: number | null = null;

  if (topic) {
    threadIdFound = threads.find(byTopic)?.id;
  } else if (content) {
    threadIdFound = threads.find(byContent)?.id;
  }

  if (threadIdFound) {
    await azureApiGit.updateThread(
      {
        status: 4, // close
      },
      config.repoId,
      issueNo,
      threadIdFound
    );
  }
}

export function setBranchStatus({
  branchName,
  context,
  description,
  state,
  url: targetUrl,
}: BranchStatusConfig): Promise<void> {
  logger.debug(
    `setBranchStatus(${branchName}, ${context}, ${description}, ${state}, ${targetUrl}) - Not supported by Azure DevOps (yet!)`
  );
  return Promise.resolve();
}

export function mergePr(pr: number, branchName: string): Promise<boolean> {
  logger.debug(`mergePr(pr)(${pr}) - Not supported by Azure DevOps (yet!)`);
  return Promise.resolve(false);
}

export function getPrBody(input: string): string {
  // Remove any HTML we use
  return smartTruncate(input, 4000)
    .replace(
      'you tick the rebase/retry checkbox',
      'rename PR to start with "rebase!"'
    )
    .replace(new RegExp(`\n---\n\n.*?<!-- rebase-check -->.*?\n`), '')
    .replace('<summary>', '**')
    .replace('</summary>', '**')
    .replace('<details>', '')
    .replace('</details>', '');
}

export /* istanbul ignore next */ function findIssue(): Promise<Issue | null> {
  logger.warn(`findIssue() is not implemented`);
  return null;
}

export /* istanbul ignore next */ function ensureIssue(): Promise<EnsureIssueResult | null> {
  logger.warn(`ensureIssue() is not implemented`);
  return Promise.resolve(null);
}

export /* istanbul ignore next */ function ensureIssueClosing(): Promise<void> {
  return Promise.resolve();
}

export /* istanbul ignore next */ function getIssueList(): Promise<Issue[]> {
  logger.debug(`getIssueList()`);
  // TODO: Needs implementation
  return Promise.resolve([]);
}

async function getUserIds(users: string[]): Promise<User[]> {
  const azureApiGit = await azureApi.gitApi();
  const azureApiCore = await azureApi.coreApi();
  const repos = await azureApiGit.getRepositories();
  const repo = repos.filter((c) => c.id === config.repoId)[0];
  const teams = await azureApiCore.getTeams(repo.project.id);
  const members = await Promise.all(
    teams.map(
      async (t) =>
        /* eslint-disable no-return-await */
        await azureApiCore.getTeamMembersWithExtendedProperties(
          repo.project.id,
          t.id
        )
    )
  );

  const ids: { id: string; name: string }[] = [];
  members.forEach((listMembers) => {
    listMembers.forEach((m) => {
      users.forEach((r) => {
        if (
          r.toLowerCase() === m.identity.displayName.toLowerCase() ||
          r.toLowerCase() === m.identity.uniqueName.toLowerCase()
        ) {
          if (ids.filter((c) => c.id === m.identity.id).length === 0) {
            ids.push({ id: m.identity.id, name: r });
          }
        }
      });
    });
  });

  teams.forEach((t) => {
    users.forEach((r) => {
      if (r.toLowerCase() === t.name.toLowerCase()) {
        if (ids.filter((c) => c.id === t.id).length === 0) {
          ids.push({ id: t.id, name: r });
        }
      }
    });
  });

  return ids;
}

/**
 *
 * @param {number} issueNo
 * @param {string[]} assignees
 */
export async function addAssignees(
  issueNo: number,
  assignees: string[]
): Promise<void> {
  logger.trace(`addAssignees(${issueNo}, [${assignees.join(', ')}])`);
  const ids = await getUserIds(assignees);
  await ensureComment({
    number: issueNo,
    topic: 'Add Assignees',
    content: ids.map((a) => `@<${a.id}>`).join(', '),
  });
}

/**
 *
 * @param {number} prNo
 * @param {string[]} reviewers
 */
export async function addReviewers(
  prNo: number,
  reviewers: string[]
): Promise<void> {
  logger.trace(`addReviewers(${prNo}, [${reviewers.join(', ')}])`);
  const azureApiGit = await azureApi.gitApi();

  const ids = await getUserIds(reviewers);

  await Promise.all(
    ids.map(async (obj) => {
      await azureApiGit.createPullRequestReviewer(
        {},
        config.repoId,
        prNo,
        obj.id
      );
      logger.debug(`Reviewer added: ${obj.name}`);
    })
  );
}

export /* istanbul ignore next */ async function deleteLabel(
  prNumber: number,
  label: string
): Promise<void> {
  logger.debug(`Deleting label ${label} from #${prNumber}`);
  const azureApiGit = await azureApi.gitApi();
  await azureApiGit.deletePullRequestLabels(config.repoId, prNumber, label);
}

export function getVulnerabilityAlerts(): Promise<VulnerabilityAlert[]> {
  return Promise.resolve([]);
}
