// --demo로 띄울 때 쓰는 가상 저장소(acme/…)와 가상 사람. 실제 저장소 이름이 화면·스크린숏에 남지 않게 한다.
// macOS판 Snapshot.swift의 DemoData와 같은 내용이다.
'use strict';

const { makeEvent } = require('./core/models');
const { createState } = require('./core/watch-state');

function demoState(now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const url = (path) => `https://github.com/${path}`;
  const state = createState();
  state.me = 'you';
  state.lastChecked = ago(1);
  state.checkedRepos = ['acme/web', 'acme/api', 'acme/design-system', 'you/dotfiles'];
  state.history = [
    makeEvent({ id: '1', repo: 'acme/web', kind: 'reviewApproved', time: ago(3), actor: 'mina', number: 128,
      title: 'Looks great, ship it 🚀', url: url('acme/web/pull/128'), isUnread: true, prAuthor: 'you' }),
    makeEvent({ id: '2', repo: 'acme/api', kind: 'prOpened', time: ago(12), actor: 'jun', number: 342,
      title: 'Add rate limiting to public endpoints', url: url('acme/api/pull/342'), isUnread: true }),
    makeEvent({ id: '3', repo: 'acme/web', kind: 'push', time: ago(25), actor: 'sora', branch: 'feat/search',
      title: 'feat: debounce search input', url: url('acme/web'), commitCount: 3, isUnread: true }),
    makeEvent({ id: '4', repo: 'acme/design-system', kind: 'reviewChangesRequested', time: ago(48), actor: 'lee',
      number: 57, title: 'Button contrast fails WCAG AA in dark mode', url: url('acme/design-system/pull/57') }),
    makeEvent({ id: '9', repo: 'acme/design-system', kind: 'comment', time: ago(70), actor: 'review-helper[bot]',
      number: 57, title: 'Contrast check: 2 issues found', url: url('acme/design-system/pull/57') }),
    makeEvent({ id: '5', repo: 'acme/api', kind: 'prMerged', time: ago(95), actor: 'mina', number: 339,
      title: 'Migrate auth tokens to rotating keys', url: url('acme/api/pull/339') }),
    makeEvent({ id: '6', repo: 'acme/web', kind: 'comment', time: ago(130), actor: 'jun', number: 127,
      title: 'Can we keep the old route as a redirect for a week?', url: url('acme/web/pull/127'), prAuthor: 'you' }),
    makeEvent({ id: '7', repo: 'acme/api', kind: 'branchCreated', time: ago(60 * 20), actor: 'sora',
      branch: 'fix/timeout', title: 'fix: raise upstream timeout to 30s', url: url('acme/api') }),
    makeEvent({ id: '8', repo: 'acme/design-system', kind: 'prOpened', time: ago(60 * 22), actor: 'lee', number: 56,
      title: 'New color tokens for charts', url: url('acme/design-system/pull/56') }),
  ];
  return state;
}

module.exports = { demoState };
