// 댓글·커밋 본문에서 목록과 알림에 보일 한 줄을 뽑는다(마크다운 기호는 뺀다).
// 봇 댓글은 HTML 주석이나 태그로 시작하고, 답글은 인용('>')으로 시작하는 일이 많다.
// 리뷰 제안(```suggestion)·코드 블록은 건너뛰고, 이미지만 있는 댓글은 빈 줄로 본다(화면은 종류 이름으로 대신한다).
'use strict';

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const EMPHASIS = /(\*\*|__|~~|`)/g;

/** 줄 안의 마크다운: 이미지는 빼고, 링크는 글자만 남기고, 굵게·기울임·코드 표시를 지운다. */
function inline(line) {
  return line.replace(IMAGE, ' ').replace(LINK, '$1').replace(EMPHASIS, '');
}

function firstLine(text) {
  if (!text) return '';
  const cleaned = text.replace(HTML_COMMENT, ' ').replace(HTML_TAG, ' ');
  let inFence = false;
  const outside = [];
  for (const line of cleaned.split(/\r\n|[\n\r\u0085\u2028\u2029]/)) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) outside.push(line);
  }
  const lines = outside
    .map((line) => inline(line).trim())
    .filter((line) => line !== '');
  const meaningful = lines.filter((line) => !line.startsWith('>'));
  const line = (meaningful.length ? meaningful : lines)[0];
  if (line === undefined) return '';
  return line.replace(/^#+/, '').trim();
}

module.exports = { firstLine };
