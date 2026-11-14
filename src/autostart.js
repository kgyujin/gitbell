// Linux의 로그인 시 실행. Electron의 setLoginItemSettings는 Linux를 지원하지 않아
// XDG 자동 시작 규칙대로 ~/.config/autostart/gitbell.desktop 파일을 두고 지운다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** @param {{dir: string, command: string}} options dir: autostart 폴더, command: 실행할 명령 */
function linuxAutostart({ dir, command }) {
  const file = path.join(dir, 'gitbell.desktop');
  return {
    isEnabled: () => fs.existsSync(file),
    setEnabled(on) {
      if (!on) return fs.rmSync(file, { force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, [
        '[Desktop Entry]',
        'Type=Application',
        'Name=GitBell',
        `Exec=${command}`,
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'));
    },
  };
}

module.exports = { linuxAutostart };
