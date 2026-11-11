// 저장소 원자료(snapshot)를 활동 항목으로 바꾼다(EventBuilder.swift와 같은 규칙).
//
// - since 이후에 생긴 것만 만든다. 같은 사건은 항상 같은 id가 나와 중복을 거를 수 있다.
// - 머지된 PR은 '닫힘'으로 또 만들지 않는다. 머지한 사람은 저장소 활동의 pr_merge에서 찾는다.
// - 빈 COMMENTED 리뷰는 인라인 댓글을 감싼 껍데기라 건너뛰고, 본문 있는 리뷰에 딸린 인라인 댓글은 뺀다.
// - push는 저장소 Activity API로 읽는다. pr_merge, 브랜치 삭제, 봇 push는 뺀다.
//
// snapshot의 필드는 GitHub 응답 그대로(snake_case)다.
'use strict';

const { EventKind, isPush, makeEvent, time, encodePath } = require('./models');
const { firstLine } = require('./text-preview');

const ZERO_SHA = '0'.repeat(40);

function isBot(login) {
  return login.endsWith('[bot]');
}

function numberFromURL(url) {
  if (!url) return null;
  const tail = url.split('/').filter(Boolean).pop();
  return /^[+-]?\d+$/.test(tail || '') ? Number(tail) : null;
}

/**
 * @param {{pulls?: object[], reviewsByPR?: Object<number, object[]>, reviewComments?: object[],
 *          issueComments?: object[], activity?: object[]}} raw
 * @param {string} repo  'owner/name'
 * @param {string} since ISO 시각
 */
function build(raw, repo, since) {
  const pulls = raw.pulls || [];
  const reviewsByPR = raw.reviewsByPR || {};
  const reviewComments = raw.reviewComments || [];
  const issueComments = raw.issueComments || [];
  const activity = raw.activity || [];

  const sinceTime = time(since);
  const repoURL = `https://github.com/${repo}`;
  const repoPath = (path) => `${repoURL}/${encodePath(path)}`;
  const recent = (date) => Boolean(date) && time(date) >= sinceTime;
  const id = (suffix) => `${repo}#${suffix}`;
  const events = [];

  // '내 PR' 판단용: PR 번호·브랜치 → PR 올린 사람.
  const authorByNumber = new Map();
  const authorByBranch = new Map();
  for (const pull of pulls) {
    const author = pull.user && pull.user.login;
    if (!author) continue;
    authorByNumber.set(pull.number, author);
    // 이 저장소 안의 브랜치만 이어 준다. 포크에서 main 같은 이름으로 올린 PR이 있으면
    // 원래 저장소의 main에 들어온 push가 모두 그 사람의 PR 활동으로 잘못 잡혔다.
    if (pull.head && pull.head.ref && pull.head.repo && pull.head.repo.full_name === repo) authorByBranch.set(pull.head.ref, author);
  }

  const mergerBySHA = new Map();
  for (const item of activity) {
    // 머지 대기열(merge queue)로 머지한 것도 머지한 사람을 찾을 수 있게 함께 본다.
    const isMerge = item.activity_type === 'pr_merge' || item.activity_type === 'merge_queue_merge';
    if (isMerge && item.after && item.actor) mergerBySHA.set(item.after, item.actor);
  }

  for (const pull of pulls) {
    if (recent(pull.created_at)) {
      events.push(makeEvent({
        id: id(`pr-open:${pull.number}`), repo, kind: EventKind.prOpened, time: pull.created_at,
        actor: (pull.user && pull.user.login) || '', actorAvatarURL: (pull.user && pull.user.avatar_url) || null,
        number: pull.number, title: pull.title, url: pull.html_url,
      }));
    }
    if (recent(pull.merged_at)) {
      const merger = pull.merge_commit_sha ? mergerBySHA.get(pull.merge_commit_sha) : undefined;
      events.push(makeEvent({
        id: id(`pr-merged:${pull.number}`), repo, kind: EventKind.prMerged, time: pull.merged_at,
        actor: (merger && merger.login) || '', actorAvatarURL: (merger && merger.avatar_url) || null,
        number: pull.number, title: pull.title, url: pull.html_url,
      }));
    } else if (recent(pull.closed_at)) {
      events.push(makeEvent({
        id: id(`pr-closed:${pull.number}`), repo, kind: EventKind.prClosed, time: pull.closed_at,
        actor: '', number: pull.number, title: pull.title, url: pull.html_url,
      }));
    }
  }

  const reviewIDsShown = new Set();
  for (const [numberKey, reviews] of Object.entries(reviewsByPR)) {
    const number = Number(numberKey);
    for (const review of reviews) {
      if (!recent(review.submitted_at)) continue;
      const body = firstLine(review.body);
      let kind;
      if (review.state === 'APPROVED') kind = EventKind.reviewApproved;
      else if (review.state === 'CHANGES_REQUESTED') kind = EventKind.reviewChangesRequested;
      else if (review.state === 'COMMENTED' && body !== '') kind = EventKind.reviewCommented;
      else continue;
      reviewIDsShown.add(review.id);
      events.push(makeEvent({
        id: id(`review:${review.id}`), repo, kind, time: review.submitted_at,
        actor: (review.user && review.user.login) || '', actorAvatarURL: (review.user && review.user.avatar_url) || null,
        number, title: body, url: review.html_url || repoPath(`pull/${number}`),
      }));
    }
  }

  for (const comment of reviewComments) {
    if (!recent(comment.created_at)) continue;
    if (comment.pull_request_review_id != null && reviewIDsShown.has(comment.pull_request_review_id)) continue;
    events.push(makeEvent({
      id: id(`rc:${comment.id}`), repo, kind: EventKind.comment, time: comment.created_at,
      actor: (comment.user && comment.user.login) || '', actorAvatarURL: (comment.user && comment.user.avatar_url) || null,
      number: numberFromURL(comment.pull_request_url), title: firstLine(comment.body),
      url: comment.html_url || repoURL,
    }));
  }

  for (const comment of issueComments) {
    if (!recent(comment.created_at)) continue;
    const isIssue = !(comment.html_url || '').includes('/pull/');
    events.push(makeEvent({
      id: id(`ic:${comment.id}`), repo, kind: EventKind.comment, time: comment.created_at,
      actor: (comment.user && comment.user.login) || '', actorAvatarURL: (comment.user && comment.user.avatar_url) || null,
      number: numberFromURL(comment.issue_url), title: firstLine(comment.body),
      url: comment.html_url || repoURL, isIssue,
    }));
  }

  for (const item of activity) {
    const actor = (item.actor && item.actor.login) || '';
    if (!(time(item.timestamp) >= sinceTime) || isBot(actor)) continue;
    let kind;
    if (item.activity_type === 'push') kind = EventKind.push;
    else if (item.activity_type === 'force_push') kind = EventKind.forcePush;
    else if (item.activity_type === 'branch_creation') kind = EventKind.branchCreated;
    else continue;
    // 앞에 붙은 refs/heads/만 뗀다(브랜치 이름 안에 같은 글자가 있어도 그대로 둔다).
    const branch = (item.ref || '').replace(/^refs\/heads\//, '');
    const before = item.before || '';
    const after = item.after || '';
    let url;
    if (kind === EventKind.push) url = repoPath(`compare/${before}...${after}`);
    else if (kind === EventKind.forcePush) url = repoPath(`commit/${after}`);
    else url = repoPath(`tree/${branch}`);
    events.push(makeEvent({
      id: id(`act:${item.id}`), repo, kind, time: item.timestamp,
      actor, actorAvatarURL: (item.actor && item.actor.avatar_url) || null, branch, title: '',
      url, before, after, detailResolved: false,
    }));
  }

  for (const event of events) {
    if (event.branch != null && isPush(event.kind)) {
      event.prAuthor = authorByBranch.get(event.branch) || null;
    } else if (event.number != null && !event.isIssue) {
      event.prAuthor = authorByNumber.get(event.number) || null;
    }
  }
  return events.sort((a, b) => time(a.time) - time(b.time));
}

module.exports = { build, isBot, numberFromURL, ZERO_SHA };
