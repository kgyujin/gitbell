// 알림과 목록 표시에 관한 사용자 설정, 그 설정으로 항목을 거르는 순수 함수.
//
// - 알림: 전체 켜기·끄기, 소리, 종류 묶음별 켜기·끄기, 내 PR 소식만
// - 숨긴 저장소: 목록·안 읽은 수·알림에서 모두 뺀다(기록은 남겨 다시 보이게 할 수 있다)
// - 봇 활동 숨기기: 이름이 '[bot]'으로 끝나는 계정의 활동을 목록·알림에서 뺀다
'use strict';

const { NotificationGroup, notificationGroupOf } = require('./models');
const { isBot } = require('./event-builder');
const { isOnMyPullRequest } = require('./activity-query');

const ALL_GROUPS = Object.values(NotificationGroup);

/** 저장된 값을 읽되, 없거나 모양이 다른 값은 기본값으로 채운다. */
function notificationPreferences(saved = {}) {
  const value = saved && typeof saved === 'object' ? saved : {};
  const bool = (key, fallback) => (typeof value[key] === 'boolean' ? value[key] : fallback);
  return {
    isEnabled: bool('isEnabled', true),
    playsSound: bool('playsSound', true),
    groups: Array.isArray(value.groups) ? ALL_GROUPS.filter((g) => value.groups.includes(g)) : [...ALL_GROUPS],
    onlyMyPullRequests: bool('onlyMyPullRequests', false),
  };
}

function displayPreferences(saved = {}) {
  const value = saved && typeof saved === 'object' ? saved : {};
  return {
    hiddenRepositories: Array.isArray(value.hiddenRepositories) ? [...new Set(value.hiddenRepositories)].sort() : [],
    hidesBots: value.hidesBots === true,
  };
}

function allows(prefs, event, me = '') {
  if (!prefs.isEnabled || !prefs.groups.includes(notificationGroupOf(event.kind))) return false;
  return !prefs.onlyMyPullRequests || isOnMyPullRequest(event, me);
}

/** 목록·안 읽은 수·알림에 넣을지. */
function shows(display, event) {
  if (display.hiddenRepositories.includes(event.repo)) return false;
  if (display.hidesBots && isBot(event.actor)) return false;
  return true;
}

function visible(display, events) {
  return events.filter((event) => shows(display, event));
}

/** 새 항목 중 실제로 알림을 띄울 것만 고른다. */
function eventsToNotify(events, notifications, display, me = '') {
  return events.filter((event) => shows(display, event) && allows(notifications, event, me));
}

/** 화면에 보이는(숨기지 않은) 항목 중 안 읽은 수. */
function visibleUnreadCount(state, display) {
  return state.history.filter((event) => event.isUnread && shows(display, event)).length;
}

/** '0.10.2'처럼 점으로 나뉜 버전을 비교한다. 숫자가 아닌 부분은 0으로 본다. */
function isNewerVersion(candidate, current) {
  const parts = (version) => version.split('-')[0].split('.').filter((p) => p !== '').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const lhs = parts(candidate);
  const rhs = parts(current);
  for (let i = 0; i < Math.max(lhs.length, rhs.length); i += 1) {
    const a = lhs[i] || 0;
    const b = rhs[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

module.exports = {
  ALL_GROUPS,
  notificationPreferences,
  displayPreferences,
  allows,
  shows,
  visible,
  eventsToNotify,
  visibleUnreadCount,
  isNewerVersion,
};
