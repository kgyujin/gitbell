// 댓글·커밋 본문에서 목록에 보일 한 줄을 뽑는다(TextPreview.swift와 같은 규칙).
// 봇 댓글은 HTML 주석이나 태그로 시작하고, 답글은 인용('>')으로 시작하는 일이 많다.
'use strict';

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

function firstLine(text) {
  if (!text) return '';
  const cleaned = text.replace(HTML_COMMENT, ' ').replace(HTML_TAG, ' ');
  const lines = cleaned
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const meaningful = lines.filter((line) => !line.startsWith('>'));
  const line = (meaningful.length ? meaningful : lines)[0];
  if (line === undefined) return '';
  return line.replace(/^#+/, '').trim();
}

module.exports = { firstLine };
