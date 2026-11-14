// 트레이 아이콘을 canvas로 그린다. 종 · 안 읽은 수 배지(또는 점) · 연결 문제면 사선.
// 16px(100%)와 32px(200%) 두 크기를 그려 주 프로세스에 넘긴다.
'use strict';

const BELL = 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9';
const CLAPPER = 'M10.3 21a1.94 1.94 0 0 0 3.4 0';
const BADGE_COLOR = '#e5484d';

/**
 * template: macOS 메뉴 막대용. 검은색 하나로 그리면 시스템이 메뉴 막대 색에 맞춰 칠한다.
 * 이때 안 읽은 수는 아이콘 옆 글자(tray.setTitle)로 보이므로 배지 대신 점만 그린다(수를 끈 경우).
 */
function drawTrayIcon(canvas, size, { unread, showsCount, hasProblem, dark, template = false }) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const unit = size / 24;
  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.scale(unit, unit);
  ctx.strokeStyle = template ? '#000000' : (dark ? '#ffffff' : '#1f1f1f');
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(BELL));
  ctx.stroke(new Path2D(CLAPPER));
  if (hasProblem) {
    // 사선 둘레를 지운 뒤 사선을 그어 종과 겹쳐도 잘 보이게 한다.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(3, 3);
    ctx.lineTo(21, 21);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }
  ctx.restore();

  if (hasProblem || unread <= 0 || (template && showsCount)) return canvas.toDataURL('image/png');

  if (!showsCount) {
    const radius = size * 0.2;
    badge(ctx, size - radius - size * 0.02, radius + size * 0.02, radius, radius, template ? '#000000' : BADGE_COLOR);
    return canvas.toDataURL('image/png');
  }

  const text = unread > 99 ? '99+' : String(unread);
  const height = size * 0.62;
  const padding = height * 0.45;
  let fontSize = Math.round(height * 0.82);
  const setFont = () => { ctx.font = `bold ${fontSize}px "Segoe UI", system-ui, sans-serif`; };
  setFont();
  // '99+'처럼 긴 글자는 그대로 그리면 아이콘 폭을 넘어 왼쪽이 잘린다. 넘치면 글자를 줄여 아이콘 안에(왼쪽에 조금 띄워) 맞춘다.
  const maxWidth = size - Math.max(1, size * 0.06);
  if (ctx.measureText(text).width + padding > maxWidth) {
    fontSize = Math.floor(fontSize * (maxWidth - padding) / ctx.measureText(text).width);
    setFont();
  }
  const width = Math.min(maxWidth, Math.max(height, ctx.measureText(text).width + padding));
  const centerX = size - width / 2;
  const centerY = height / 2;
  badge(ctx, centerX, centerY, width / 2, height / 2);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, centerX, centerY + size * 0.02, width);
  return canvas.toDataURL('image/png');
}

/** 둘레를 조금 지우고 빨간 알약(또는 원)을 그린다. */
function badge(ctx, centerX, centerY, halfWidth, halfHeight, color = BADGE_COLOR) {
  const pill = (grow) => {
    ctx.beginPath();
    ctx.roundRect(centerX - halfWidth - grow, centerY - halfHeight - grow, (halfWidth + grow) * 2, (halfHeight + grow) * 2, halfHeight + grow);
  };
  ctx.globalCompositeOperation = 'destination-out';
  pill(ctx.canvas.width * 0.06);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  pill(0);
  ctx.fill();
}

function drawTrayIcons(canvas, request) {
  return { x1: drawTrayIcon(canvas, 16, request), x2: drawTrayIcon(canvas, 32, request) };
}
