// 화면 문구. 키는 영어 원문이다(macOS판 L10n.swift와 같은 규칙).
// 한국어는 macOS판과 같은 Resources/ko.lproj/Localizable.strings를 읽고,
// Windows에만 있는 문구는 src/locales/ko.strings에 둔다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPush, repoName } = require('./core/models');

const SHARED_STRINGS = path.join(__dirname, '..', '..', 'Resources', 'ko.lproj', 'Localizable.strings');
const WINDOWS_STRINGS = path.join(__dirname, 'locales', 'ko.strings');

/** Apple .strings 파일("키" = "값";)을 읽는다. 주석과 빈 줄은 건너뛴다. */
function parseStrings(text) {
  const strings = new Map();
  const unescape = (value) => value.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/);
    if (match) strings.set(unescape(match[1]), unescape(match[2]));
  }
  return strings;
}

function loadKoreanStrings() {
  const strings = new Map();
  for (const file of [SHARED_STRINGS, WINDOWS_STRINGS]) {
    for (const [key, value] of parseStrings(fs.readFileSync(file, 'utf8'))) strings.set(key, value);
  }
  return strings;
}

/**
 * 개수가 1일 때 영어에서 쓰는 단수형 키("Pushed 1 commits" 대신 "Pushed 1 commit").
 * 한국어는 단수·복수 구분이 없어 원래 키의 번역을 그대로 쓴다. macOS판 L10n.swift와 같은 표다.
 */
const SINGULAR = Object.freeze({
  'Pushed %lld commits': 'Pushed %lld commit',
  '%lld items': '%lld item',
  'Checked %@ · %lld repositories': 'Checked %@ · %lld repository',
  "Couldn't read %lld repositories:": "Couldn't read %lld repository:",
  '%lld new activities': '%lld new activity',
  'Marked %lld items as read': 'Marked %lld item as read',
});

/** %lld 자리에 들어갈 값이 1이고 번역이 없으면(영어) 단수형 키를 고른다. */
function pluralKey(key, args, translated) {
  if (translated || !SINGULAR[key]) return key;
  const tokens = key.match(/%lld|%@/g) || [];
  const count = args[tokens.indexOf('%lld')];
  return Number(count) === 1 ? SINGULAR[key] : key;
}

/** 첫 번째 선호 언어가 한국어인지. GITBELL_LANG(ko/en)으로 바꿀 수 있다. */
function prefersKorean(languages, override = process.env.GITBELL_LANG) {
  if (/^ko/i.test(override || '')) return true;
  if (/^en/i.test(override || '')) return false;
  return /^ko/i.test((languages && languages[0]) || '');
}

/**
 * @param {{korean: boolean, strings?: Map<string,string>, now?: () => number}} options
 */
function createL10n({ korean, strings = korean ? loadKoreanStrings() : new Map(), now = Date.now }) {
  const locale = korean ? 'ko-KR' : 'en-US';
  const t = (key) => (korean && strings.has(key) ? strings.get(key) : key);
  /** %lld·%@ 자리에 값을 차례로 넣는다. */
  const format = (key, ...args) => {
    let index = 0;
    const chosen = pluralKey(key, args, korean && strings.has(key));
    return t(chosen).replace(/%lld|%@/g, () => String(args[index++]));
  };

  function kindLabel(event) {
    switch (event.kind) {
      case 'prOpened': return t('Opened');
      case 'prMerged': return t('Merged');
      case 'prClosed': return t('Closed');
      case 'reviewApproved': return t('Approved');
      case 'reviewChangesRequested': return t('Changes requested');
      case 'reviewCommented': return t('Reviewed');
      case 'comment': return t('Commented');
      case 'push': return event.commitCount > 0 ? format('Pushed %lld commits', event.commitCount) : t('Pushed');
      case 'forcePush': return t('Force-pushed');
      default: return t('New branch');
    }
  }

  /** '#33', '이슈 #12', '⎇ feat/x'처럼 무엇에 일어났는지. */
  function target(event) {
    if (event.branch != null && isPush(event.kind)) return `⎇ ${event.branch}`;
    if (event.number == null) return '';
    return event.isIssue ? format('Issue #%lld', event.number) : `#${event.number}`;
  }

  /** 봇 계정의 '[bot]' 꼬리를 뗀다. */
  const displayName = (login) => (login.endsWith('[bot]') ? login.slice(0, -5) : login);

  /** 알림 부제목: '머지됨 · #33 · octocat' */
  const headline = (event) => [kindLabel(event), target(event), displayName(event.actor)].filter(Boolean).join(' · ');

  /** 본문 한 줄. 비어 있으면 종류 이름으로 대신한다. */
  const title = (event) => event.title || kindLabel(event);

  const categoryLabel = (category) => ({ pullRequests: t('PRs'), reviews: t('Reviews'), commits: t('Commits') }[category] || t('All'));

  const groupLabel = (group) => t({
    newPullRequests: 'New pull requests', merges: 'Merged or closed', reviews: 'Reviews', comments: 'Comments', commits: 'Commits',
  }[group]);

  const groupDetail = (group) => t({
    newPullRequests: 'When someone opens a pull request',
    merges: 'When a pull request is merged or closed',
    reviews: 'Approvals, change requests and review notes',
    comments: 'Comments on pull requests and issues',
    commits: 'Pushes, force pushes and new branches',
  }[group]);

  const sortLabel = (sort) => t({ newest: 'Newest', byRepository: 'By repository', unreadFirst: 'Unread first' }[sort]);

  function dayTitle(iso) {
    const date = new Date(iso);
    const today = new Date(now());
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(today) - startOf(date)) / 86400000);
    if (days === 0) return t('Today');
    if (days === 1) return t('Yesterday');
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
  }

  function sectionTitle(key) {
    switch (key.type) {
      case 'day': return dayTitle(key.date);
      case 'repository': return repoName(key.repo);
      case 'unread': return t('Unread');
      default: return t('Read');
    }
  }

  const clock = (iso) => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(iso));

  return {
    korean, locale, t, format, kindLabel, target, displayName, headline, title,
    categoryLabel, groupLabel, groupDetail, sortLabel, dayTitle, sectionTitle, clock,
  };
}

module.exports = {
  parseStrings, loadKoreanStrings, prefersKorean, createL10n, pluralKey, SINGULAR, SHARED_STRINGS, WINDOWS_STRINGS,
};
