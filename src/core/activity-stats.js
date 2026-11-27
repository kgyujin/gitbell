// 활동 통계: 날짜별 합계(daily)를 쌓아 두고, 그것으로 최근 7일 막대·6개월 잔디·활동이 많은 저장소를 만든다.
// 날짜는 이 컴퓨터의 시간대로 나눈다(자정 기준).
//
// 목록 기록(history)은 최근 150개만 남아서 지난 날짜가 비어 보였다. 그래서 기록에 새 항목이 들어올 때마다
// 날짜별 합계에도 더해 두고, 통계는 이 합계로 그린다.
//
// daily: { 'YYYY-MM-DD': { 'owner/repo': [PR, 리뷰, 커밋, 봇 PR, 봇 리뷰, 봇 커밋] } }
//   저장소와 봇을 나눠 두어, 숨긴 저장소·'봇 활동 숨기기'를 통계에도 그대로 적용한다.
'use strict';

const { categoryOf, EventCategory, time } = require('./models');
const { isBot } = require('./event-builder');

const CATEGORIES = Object.values(EventCategory);
/** 잔디(26주)와 이번 주를 그릴 만큼 남긴다. */
const DAILY_KEEP_DAYS = 27 * 7;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 이 컴퓨터 시간대의 'YYYY-MM-DD'. */
function localDate(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 'YYYY-MM-DD'의 이 컴퓨터 시간대 자정. */
function dayStart(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
}

const emptyCounts = () => Object.fromEntries(CATEGORIES.map((category) => [category, 0]));

/** 기록에 새로 들어온 항목 하나를 날짜별 합계에 더한다. */
function addToDaily(daily, event) {
  const ms = time(event.time);
  if (!Number.isFinite(ms) || !event.repo) return;
  const date = localDate(ms);
  const slot = CATEGORIES.indexOf(categoryOf(event.kind)) + (isBot(event.actor || '') ? CATEGORIES.length : 0);
  const repos = daily[date] || (daily[date] = {});
  const counts = repos[event.repo] || (repos[event.repo] = new Array(CATEGORIES.length * 2).fill(0));
  counts[slot] += 1;
}

/** keepDays보다 오래된 날짜를 지운다. */
function pruneDaily(daily, now, keepDays = DAILY_KEEP_DAYS) {
  const oldest = new Date(time(now));
  oldest.setHours(0, 0, 0, 0);
  oldest.setDate(oldest.getDate() - keepDays);
  const cutoff = localDate(oldest.getTime());
  for (const date of Object.keys(daily)) {
    if (date < cutoff) delete daily[date];
  }
}

/** 날짜별 합계가 없던 예전 상태: 남아 있는 기록으로 채운다. */
function dailyFromHistory(history) {
  const daily = {};
  for (const event of history) addToDaily(daily, event);
  return daily;
}

/** 저장된 값을 읽되, 모양이 다른 것은 버린다(망가진 파일 때문에 통계 화면이 멈추지 않게). */
function sanitizeDaily(value) {
  if (!value || typeof value !== 'object') return null;
  const daily = {};
  for (const [date, repos] of Object.entries(value)) {
    if (!DATE_PATTERN.test(date) || !repos || typeof repos !== 'object') continue;
    for (const [repo, counts] of Object.entries(repos)) {
      if (!Array.isArray(counts) || counts.length !== CATEGORIES.length * 2) continue;
      if (!counts.every((n) => Number.isInteger(n) && n >= 0)) continue;
      (daily[date] || (daily[date] = {}))[repo] = counts.slice();
    }
  }
  return daily;
}

/**
 * 하루의 종류별 수(숨긴 저장소·봇 설정 반영). byRepo: 저장소별 합계를 더해 줄 Map(없으면 세지 않는다).
 * @param {{hiddenRepositories?: string[], hidesBots?: boolean}} display
 */
function countDay(repos, display = {}, byRepo = null) {
  const counts = emptyCounts();
  const hidden = new Set(display.hiddenRepositories || []);
  for (const [repo, values] of Object.entries(repos || {})) {
    if (hidden.has(repo)) continue;
    let repoTotal = 0;
    CATEGORIES.forEach((category, index) => {
      const value = values[index] + (display.hidesBots ? 0 : values[index + CATEGORIES.length]);
      counts[category] += value;
      repoTotal += value;
    });
    if (byRepo && repoTotal) byRepo.set(repo, (byRepo.get(repo) || 0) + repoTotal);
  }
  const total = CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
  return { counts, total };
}

/** 오늘 자정(이 컴퓨터 시간대). */
function todayStart(now) {
  const today = new Date(time(now));
  today.setHours(0, 0, 0, 0);
  return today;
}

/**
 * 최근 며칠의 날짜별·종류별 수와 활동이 많은 저장소.
 * @param {object} daily  날짜별 합계
 * @param {{now: string, days?: number, topRepos?: number, display?: object}} options
 * @returns {{days: {date: string, counts: object, total: number}[], repos: {repo: string, count: number}[],
 *   totals: object, total: number, max: number}}  days는 오래된 날부터, max는 하루 합계의 최댓값.
 */
function activityStats(daily, { now, days = 7, topRepos = 5, display = {} }) {
  const today = todayStart(now);
  const totals = emptyCounts();
  const byRepo = new Map();
  const buckets = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const start = new Date(today);
    start.setDate(today.getDate() - offset);
    const date = localDate(start.getTime());
    const { counts, total } = countDay(daily[date], display, byRepo);
    for (const category of CATEGORIES) totals[category] += counts[category];
    buckets.push({ date, counts, total });
  }
  const repos = [...byRepo].map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo))
    .slice(0, topRepos);
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  return { days: buckets, repos, totals, total, max: Math.max(0, ...buckets.map((bucket) => bucket.total)) };
}

/**
 * GitHub 잔디처럼 주(열) × 요일(행) 칸. 열은 일요일에 시작하고, 마지막 열이 이번 주다.
 * 칸의 진하기(level 0~4)는 기간 안에서 가장 많은 날을 4로 두고 나눈다. 오늘 뒤의 칸은 future다.
 * @returns {{weeks: {date: string, counts: object, total: number, level: number, future: boolean}[][],
 *   total: number, max: number, activeDays: number, busiest: {date: string, total: number}|null}}
 */
function heatmap(daily, { now, weeks = 26, display = {} }) {
  const today = todayStart(now);
  const first = new Date(today);
  first.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);
  const columns = [];
  let max = 0;
  let total = 0;
  let activeDays = 0;
  let busiest = null;
  for (let week = 0; week < weeks; week += 1) {
    const column = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = new Date(first);
      day.setDate(first.getDate() + week * 7 + weekday);
      const date = localDate(day.getTime());
      const future = day > today;
      const { counts, total: dayTotal } = future ? { counts: emptyCounts(), total: 0 } : countDay(daily[date], display);
      column.push({ date, counts, total: dayTotal, level: 0, future });
      total += dayTotal;
      if (dayTotal > 0) activeDays += 1;
      if (dayTotal > max) max = dayTotal;
      if (dayTotal > 0 && (!busiest || dayTotal > busiest.total)) busiest = { date, total: dayTotal };
    }
    columns.push(column);
  }
  for (const column of columns) {
    for (const cell of column) cell.level = cell.total === 0 ? 0 : Math.min(4, Math.ceil((cell.total / max) * 4));
  }
  return { weeks: columns, total, max, activeDays, busiest };
}

module.exports = {
  activityStats, heatmap, addToDaily, pruneDaily, dailyFromHistory, sanitizeDaily, countDay,
  localDate, dayStart, CATEGORIES, DAILY_KEEP_DAYS,
};
