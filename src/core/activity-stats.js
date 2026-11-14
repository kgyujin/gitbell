// 활동 차트에 쓰는 집계: 최근 며칠의 날짜별·종류별 활동 수와 활동이 많은 저장소.
// 날짜는 이 컴퓨터의 시간대로 나눈다(자정 기준).
'use strict';

const { categoryOf, EventCategory, time } = require('./models');

const CATEGORIES = Object.values(EventCategory);

/** 이 컴퓨터 시간대의 'YYYY-MM-DD'. */
function localDate(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const emptyCounts = () => Object.fromEntries(CATEGORIES.map((category) => [category, 0]));

/**
 * @param {object[]} events  기록(보이는 항목)
 * @param {{now: string, days?: number, topRepos?: number}} options
 * @returns {{days: {date: string, counts: object, total: number}[], repos: {repo: string, count: number}[],
 *   totals: object, total: number, max: number}}  days는 오래된 날부터, max는 하루 합계의 최댓값.
 */
function activityStats(events, { now, days = 7, topRepos = 5 }) {
  const today = new Date(time(now));
  today.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const start = new Date(today);
    start.setDate(today.getDate() - offset);
    buckets.push({ date: localDate(start.getTime()), counts: emptyCounts(), total: 0 });
  }
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  const totals = emptyCounts();
  const repoCounts = new Map();
  for (const event of events) {
    const bucket = byDate.get(localDate(time(event.time)));
    if (!bucket) continue;
    const category = categoryOf(event.kind);
    bucket.counts[category] += 1;
    bucket.total += 1;
    totals[category] += 1;
    repoCounts.set(event.repo, (repoCounts.get(event.repo) || 0) + 1);
  }
  const repos = [...repoCounts].map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo))
    .slice(0, topRepos);
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  return { days: buckets, repos, totals, total, max: Math.max(0, ...buckets.map((bucket) => bucket.total)) };
}

module.exports = { activityStats, localDate, CATEGORIES };
