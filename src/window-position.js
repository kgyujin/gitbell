// 트레이 아이콘 옆에 패널을 띄울 위치. 작업 표시줄은 아래가 기본이지만 위·왼쪽·오른쪽에 둘 수도 있다.
'use strict';

const MARGIN = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/**
 * @param {{trayBounds: {x,y,width,height}, size: {width,height}, workArea: {x,y,width,height}}} input
 * @returns {{x: number, y: number}}
 */
function panelPosition({ trayBounds, size, workArea }) {
  const minX = workArea.x + MARGIN;
  const maxX = workArea.x + workArea.width - size.width - MARGIN;
  const minY = workArea.y + MARGIN;
  const maxY = workArea.y + workArea.height - size.height - MARGIN;
  // 트레이 위치를 모르면(일부 환경) 작업 영역 오른쪽 아래에 둔다.
  if (!trayBounds || (trayBounds.width === 0 && trayBounds.height === 0)) {
    return { x: Math.round(maxX), y: Math.round(maxY) };
  }
  const centerX = trayBounds.x + trayBounds.width / 2;
  const centerY = trayBounds.y + trayBounds.height / 2;
  const isVerticalTaskbar = centerX < workArea.x || centerX > workArea.x + workArea.width;
  if (isVerticalTaskbar) {
    return { x: Math.round(clamp(centerX - size.width / 2, minX, maxX)), y: Math.round(clamp(centerY - size.height / 2, minY, maxY)) };
  }
  const isTopTaskbar = centerY < workArea.y + workArea.height / 2;
  const y = isTopTaskbar ? trayBounds.y + trayBounds.height + MARGIN : trayBounds.y - size.height - MARGIN;
  return { x: Math.round(clamp(centerX - size.width / 2, minX, maxX)), y: Math.round(clamp(y, minY, maxY)) };
}

module.exports = { panelPosition, MARGIN };
