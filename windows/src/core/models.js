// 활동 종류와 항목 모양. macOS판 GitBellCore/Models.swift와 같은 규칙을 JS로 옮겼다.
// 시각은 모두 ISO 8601 문자열(UTC)로 둔다. 상태 파일에 그대로 저장하고 비교할 때만 Date.parse로 바꾼다.
'use strict';

const EventKind = Object.freeze({
  prOpened: 'prOpened',
  prMerged: 'prMerged',
  prClosed: 'prClosed',
  reviewApproved: 'reviewApproved',
  reviewChangesRequested: 'reviewChangesRequested',
  reviewCommented: 'reviewCommented',
  comment: 'comment',
  push: 'push',
  forcePush: 'forcePush',
  branchCreated: 'branchCreated',
});

/** 화면 위쪽 필터에 쓰는 묶음. */
const EventCategory = Object.freeze({ pullRequests: 'pullRequests', reviews: 'reviews', commits: 'commits' });

/** 알림을 켜고 끄는 단위. */
const NotificationGroup = Object.freeze({
  newPullRequests: 'newPullRequests',
  merges: 'merges',
  reviews: 'reviews',
  comments: 'comments',
  commits: 'commits',
});

function categoryOf(kind) {
  switch (kind) {
    case EventKind.prOpened:
    case EventKind.prMerged:
    case EventKind.prClosed:
      return EventCategory.pullRequests;
    case EventKind.reviewApproved:
    case EventKind.reviewChangesRequested:
    case EventKind.reviewCommented:
    case EventKind.comment:
      return EventCategory.reviews;
    default:
      return EventCategory.commits;
  }
}

function isPush(kind) {
  return categoryOf(kind) === EventCategory.commits;
}

function notificationGroupOf(kind) {
  switch (kind) {
    case EventKind.prOpened: return NotificationGroup.newPullRequests;
    case EventKind.prMerged:
    case EventKind.prClosed: return NotificationGroup.merges;
    case EventKind.reviewApproved:
    case EventKind.reviewChangesRequested:
    case EventKind.reviewCommented: return NotificationGroup.reviews;
    case EventKind.comment: return NotificationGroup.comments;
    default: return NotificationGroup.commits;
  }
}

/** 활동 하나. id는 "owner/repo#종류:번호" 꼴이라 저장소끼리 겹치지 않는다. */
function makeEvent(fields) {
  return {
    actorAvatarURL: null,
    number: null,
    branch: null,
    isIssue: false,
    commitCount: null,
    before: null,
    after: null,
    detailResolved: true,
    isUnread: false,
    prAuthor: null,
    ...fields,
  };
}

function repoName(repo) {
  const parts = repo.split('/');
  return parts[parts.length - 1] || repo;
}

function time(value) {
  return value ? Date.parse(value) : NaN;
}

/** 'owner/repo'처럼 슬래시로 나뉜 경로를 주소에 붙일 수 있게 낱낱이 인코딩한다. */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

module.exports = {
  EventKind,
  EventCategory,
  NotificationGroup,
  categoryOf,
  isPush,
  notificationGroupOf,
  makeEvent,
  repoName,
  time,
  encodePath,
};
