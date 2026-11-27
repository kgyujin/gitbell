// '모두 읽음'이 제대로 처리되지 않던 문제들의 회귀 테스트.
// 실제 AppModel과, 알림 스레드의 읽음 상태(unread·last_read_at)를 가진 가짜 GitHub으로 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AppModel } = require('../../src/app-model');
const { createL10n } = require('../../src/l10n');
const { GitHubError } = require('../../src/core/github-api');

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function clockAt(start) {
  let ms = Date.parse(start);
  return { now: () => new Date(ms).toISOString(), advance: (minutes) => { ms += minutes * 60000; } };
}

/** 저장소 하나(o/r), PR 두 개(#5 내 PR, #6), 댓글이 달리면 그 PR의 알림 스레드가 안 읽음이 되는 GitHub. */
function fakeGitHub(clock) {
  const pull = (number, login) => ({
    number, title: `PR ${number}`, html_url: `https://github.com/o/r/pull/${number}`, user: { login }, head: { ref: `b${number}` },
    created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', merged_at: null, closed_at: null, merge_commit_sha: null,
  });
  const gh = {
    /** GitHub 서버 시계가 이 PC보다 빠른 정도(ms). */
    skewMs: 0,
    gate: null,
    patches: [],
    pulls: [pull(5, 'me'), pull(6, 'amy')],
    comments: [],
    threads: {},
    comment(number, login) {
      const at = clock.now();
      const id = 1000 + gh.comments.length;
      gh.comments.push({ id, issue_url: `https://api.github.com/repos/o/r/issues/${number}`, html_url: `https://github.com/o/r/pull/${number}#c${id}`,
        user: { login }, body: `comment ${id}`, created_at: at });
      const thread = gh.threads[number] || { id: String(9000 + number), last_read_at: null, repository: { full_name: 'o/r' },
        subject: { type: 'PullRequest', url: `https://api.github.com/repos/o/r/pulls/${number}` } };
      Object.assign(thread, { unread: true, updated_at: at });
      gh.threads[number] = thread;
      gh.pulls.find((item) => item.number === number).updated_at = at;
    },
    async get(path) {
      if (gh.gate) await gh.gate;
      const copy = (value) => JSON.parse(JSON.stringify(value));
      if (path === 'user') return { login: 'me' };
      if (path.startsWith('user/repos')) return [{ full_name: 'o/r', pushed_at: clock.now(), archived: false }];
      if (path.startsWith('notifications')) return copy(Object.values(gh.threads));
      if (path.startsWith('repos/o/r/pulls/comments')) return [];
      if (path.startsWith('repos/o/r/pulls?')) return copy(gh.pulls);
      if (/repos\/o\/r\/pulls\/\d+\/reviews/.test(path)) return [];
      if (path.startsWith('repos/o/r/issues/comments')) {
        const since = Date.parse(new URL(path, 'https://x/').searchParams.get('since'));
        return copy(gh.comments.filter((item) => Date.parse(item.created_at) >= since));
      }
      if (path.startsWith('repos/o/r/activity')) return [];
      throw new GitHubError('http', path, 404);
    },
    async patch(path) {
      if (gh.patchGate) await gh.patchGate;
      const id = path.split('/').pop();
      gh.patches.push(id);
      const thread = Object.values(gh.threads).find((item) => item.id === id);
      if (thread) Object.assign(thread, { unread: false, last_read_at: iso(Date.parse(clock.now()) + gh.skewMs) });
    },
  };
  return gh;
}

function makeModel(gh, clock, settings = null) {
  return new AppModel({
    store: { loadState: () => null, saveState() {}, loadSettings: () => settings, saveSettings() {} },
    tokens: { resolve: async () => ({ value: 't', source: 'saved' }), save: () => true, remove() {} },
    createAPI: () => gh,
    notifier: { post() {}, postTest() {}, postUpdate() {}, dismiss() {} },
    system: { openURL() {}, copyText() {}, getLaunchAtLogin: () => false, setLaunchAtLogin() {} },
    l10n: createL10n({ korean: false }),
    version: '0.6.1',
    now: clock.now,
    undoMs: 50,
  });
}

/** 첫 확인(조용히 채움) 뒤에 댓글을 달고 다시 확인해, 안 읽은 항목이 있는 상태를 만든다. */
async function withUnread(comments, settings) {
  const clock = clockAt('2026-11-26T09:00:00Z');
  const gh = fakeGitHub(clock);
  const model = makeModel(gh, clock, settings);
  await model.refresh();
  clock.advance(5);
  for (const [number, login] of comments) { gh.comment(number, login); clock.advance(1); }
  await model.refresh();
  return { clock, gh, model };
}

const unread = (model) => model.state.history.filter((event) => event.isUnread).map((event) => `${event.actor}#${event.number}`);

test('모두 읽음: 필터·검색과 상관없이 모두 읽음이 되고, 트레이 숫자도 0이 된다', async () => {
  const { model } = await withUnread([[5, 'amy'], [6, 'bob']]);
  model.setQuery({ category: 'commits', search: 'nothing' });
  assert.equal(model.viewModel().visibleUnreadCount, 0, '필터 때문에 화면에는 안 읽은 것이 없지만');
  assert.equal(model.viewModel().unreadCount, 2, '머리말·트레이 숫자는 2');
  model.markRead();
  assert.deepEqual(unread(model), []);
  assert.equal(model.trayState().unread, 0);
});

test("모두 읽음: '봇 활동 숨기기'를 켜도 숨긴 봇 댓글까지 읽고, GitHub 알림도 읽음으로 바꾼다", async () => {
  const { gh, model } = await withUnread([[5, 'amy'], [5, 'ci[bot]']], { display: { hidesBots: true } });
  model.markRead();
  await model.pendingSync;
  assert.deepEqual(unread(model), [], '숨긴 봇 댓글도 읽음');
  assert.equal(gh.threads[5].unread, false, 'GitHub 알림도 읽음(전에는 숨긴 봇 댓글 때문에 바꾸지 않았다)');
});

test("묶음 '읽음 표시': 숨긴 봇 댓글이 남아 있어도 보이는 것을 다 읽었으면 GitHub 알림을 읽음으로 바꾼다", async () => {
  const { gh, model } = await withUnread([[5, 'amy'], [5, 'ci[bot]']], { display: { hidesBots: true } });
  const section = model.viewModel().sections[0];
  model.markSectionRead(section.id);
  await model.pendingSync;
  assert.deepEqual(gh.patches, ['9005']);
  assert.deepEqual(unread(model), [], 'GitHub에서 읽은 스레드의 숨긴 봇 댓글도 읽음으로 맞춘다');
});

test('모두 읽음: 확인(새로고침)이 도는 동안 눌러도 GitHub 동기화 기록이 확인 결과에 덮이지 않는다', async () => {
  const { clock, gh, model } = await withUnread([[5, 'amy'], [6, 'bob']]);
  let release;
  gh.gate = new Promise((resolve) => { release = resolve; });
  clock.advance(2);
  const running = model.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  model.markRead();
  const sync = model.pendingSync;
  gh.gate = null;
  release();
  await running;
  await sync;
  assert.deepEqual(unread(model), []);
  assert.equal(gh.threads[5].unread, false);
  assert.equal(model.state.threads['o/r#5'].syncedAt != null, true, '동기화 기록이 남는다');
  assert.equal(model.state.threads['o/r#5'].unread, false);
});

test('되돌리기: GitHub 서버 시계가 조금 빨라도, 다음 확인이 되돌린 항목을 다시 읽음으로 바꾸지 않는다', async () => {
  const { clock, gh, model } = await withUnread([[5, 'amy']]);
  gh.skewMs = 3000;
  model.markRead();
  await model.pendingSync;
  model.undoMarkRead();
  assert.equal(model.unreadCount, 1);
  clock.advance(2);
  await model.refresh();
  assert.equal(model.unreadCount, 1, '되돌린 항목은 안 읽음 그대로');

  // 정말로 GitHub에서 다시 읽으면(한참 뒤) 그때는 반영한다.
  clock.advance(10);
  gh.threads[5].last_read_at = clock.now();
  clock.advance(2);
  await model.refresh();
  assert.equal(model.unreadCount, 0);
});

test('되돌리기: GitHub 요청이 끝나기 전에 되돌리면 그 스레드는 GitHub에서 읽음으로 바꾸지 않는다', async () => {
  const { gh, model } = await withUnread([[5, 'amy'], [6, 'bob']]);
  let release;
  gh.patchGate = new Promise((resolve) => { release = resolve; });
  model.markRead();
  const sync = model.pendingSync;
  await new Promise((resolve) => setImmediate(resolve));
  model.undoMarkRead();
  gh.patchGate = null;
  release();
  await sync;
  assert.deepEqual(gh.patches.length, 1, '이미 보낸 첫 요청 하나뿐, 되돌린 뒤의 스레드는 보내지 않는다');
  assert.equal(model.unreadCount, 2, '되돌린 항목은 그대로 안 읽음');
});
