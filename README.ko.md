<div align="center">

<img src="docs/icon.png" alt="GitBell 아이콘" width="96">

# GitBell

_GitHub 활동을 Mac 메뉴 막대나 Windows 트레이에서 바로 봅니다._

[![npm](https://img.shields.io/npm/v/gitbell?logo=npm)](https://www.npmjs.com/package/gitbell)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-black?logo=apple)](#설치)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows)](#windows)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[설치](#설치) · [기능](#기능) · [사용 팁](#사용-팁) · [자주 묻는 질문](#자주-묻는-질문) · [English](README.md)

<img src="docs/screenshot-ko.png" alt="PR, 리뷰, 머지, 커밋이 보이는 GitBell 패널" width="420">

</div>

내가 접근할 수 있는 모든 저장소의 **PR, 리뷰, 댓글, 머지, 커밋**을 메뉴 막대에서 보고, 새 활동이 생기면 알림으로 받습니다. 봇이나 웹후크 같은 저장소 설정은 필요 없습니다.

## 설치

```bash
npx gitbell
```

내 Mac에서 빌드해 `~/Applications`에 설치하고 바로 실행합니다. 메뉴 막대의 종 아이콘을 누르세요.

> [!NOTE]
> macOS 13 이상, Node.js 18 이상, Xcode 명령줄 도구(`xcode-select --install`)가 필요합니다. 내 Mac에서 직접 빌드한 앱이라 "확인되지 않은 개발자" 경고 없이 열립니다.

### Windows

PowerShell이나 명령 프롬프트에서 같은 명령을 실행합니다.

```powershell
npx gitbell
```

`%LOCALAPPDATA%\Programs\GitBell`에 설치하고 시작 메뉴에 바로가기를 만든 뒤 실행합니다. 작업 표시줄 시계 옆 트레이의 종 아이콘을 누르세요. 보이지 않으면 **^**(숨겨진 아이콘)을 열고 종 아이콘을 작업 표시줄로 끌어다 놓으세요.

> [!NOTE]
> Windows 10 이상과 Node.js 22.12 이상이 필요합니다. 처음 설치할 때 Electron(약 100MB)을 받습니다. 토큰은 내 Windows 계정으로 암호화해 이 PC에만 저장하고, 설정과 기록은 `%APPDATA%\GitBell`에 둡니다.

**GitHub 연결.** [GitHub CLI](https://cli.github.com)를 쓰고 있다면 따로 할 일이 없습니다. 쓰지 않는다면 `repo`, `notifications`, `read:org` 권한을 준 [개인 액세스 토큰](https://github.com/settings/tokens/new?scopes=repo,notifications,read:org&description=GitBell)을 앱에 붙여넣으세요.

## 기능

- **한 목록에 모두.** PR 올라옴·머지·닫힘, 승인, 수정 요청, 댓글, push, 새 브랜치를 한곳에서 봅니다.
- **원하는 알림만.** macOS 알림 배너로 알리고 소리는 켜고 끌 수 있습니다. 종류별로 끄거나 내가 올린 PR 소식만 받을 수도 있습니다.
- **빠르게 찾기.** 종류, 저장소, 안 읽음, **내 PR**(내 PR에 다른 사람이 한 활동)로 거릅니다. 정렬은 최신순, 저장소별, 안 읽은 것 먼저로 하고 검색은 제목, 사람, `#번호`로 합니다.
- **소음 줄이기.** 내 활동은 기본으로, 시끄러운 저장소는 우클릭으로 숨깁니다. 봇 계정은 스위치 하나로 모두 숨깁니다.
- **개인정보 보호.** GitHub과만 통신하고 새 버전 확인을 위해 하루 두 번 npm에 접속합니다. 토큰은 macOS 키체인에만 저장합니다.
- **한국어·영어.** macOS 언어 설정을 따릅니다.

## 사용 팁

| 하고 싶은 것 | 방법 |
| --- | --- |
| 검색 | <kbd>⌘</kbd> <kbd>F</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>F</kbd>) |
| 지금 새로고침 | <kbd>⌘</kbd> <kbd>R</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>R</kbd>) |
| 설정 열기 | <kbd>⌘</kbd> <kbd>,</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>,</kbd>) |
| 링크 복사, 안 읽음 표시, 저장소 숨기기 | 항목을 우클릭 |
| 저장소 하나를 통째로 읽음 표시 | **저장소별**로 정렬한 뒤 저장소 제목 옆 **읽음 표시** |

## 업데이트와 지우기

```bash
npx gitbell@latest                  # 업데이트 (새 버전이 나오면 앱에서도 알려 줍니다)
npx gitbell uninstall               # 앱만 지우고 설정은 남기기
npx gitbell uninstall --purge       # 설정, 기록, 저장한 토큰까지 지우기
```

Windows에서는 다른 앱처럼 **설정 → 앱 → 설치된 앱 → GitBell → 제거**로 지울 수 있습니다. 트레이 아이콘을 우클릭해 **GitBell 제거…**를 눌러도 됩니다. 확인 창에서 체크하면 설정과 저장한 토큰도 함께 지웁니다.

## 자주 묻는 질문

<details>
<summary><b>어떤 저장소가 안 보여요.</b></summary>

GitBell은 최근 3일 안에 push가 있었던 저장소와 GitHub 알림함에 새 소식이 온 저장소를 확인합니다. 조용하던 저장소도 새 활동이 생기면 바로 나타납니다. GitHub에서 그 저장소를 **Ignore**로 두지 않았는지, **설정 → 숨긴 저장소**에 들어 있지 않은지 확인하세요.

SAML SSO를 쓰는 조직이라면 토큰을 그 조직에 승인해야 합니다. `gh auth refresh`를 실행하거나, GitHub 토큰 목록에서 **Configure SSO**를 누르세요.
</details>

<details>
<summary><b>알림 배너가 안 떠요.</b></summary>

GitBell의 **설정 → 알림**에서 **테스트 알림**을 눌러 보세요. 아무것도 뜨지 않으면 **시스템 설정 → 알림 → GitBell**에서 알림을 허용하고 스타일을 **배너**나 **알림**으로 바꾸세요. 집중 모드가 켜져 있을 때도 배너가 가려집니다.

Windows에서는 **설정 → 알림 → Windows 설정 열기**에서 GitBell 알림이 켜져 있는지 확인하세요. 방해 금지(집중 지원)가 켜져 있으면 배너가 뜨지 않습니다.
</details>

<details>
<summary><b>소스에서 직접 빌드할 수 있나요?</b></summary>

```bash
git clone https://github.com/kgyujin/gitbell && cd gitbell
swift test && scripts/build-app.sh   # dist/GitBell.app 생성
```

Windows판은 `windows/` 폴더의 Electron 앱입니다.

```bash
cd windows && npm install
npm test            # 단위 테스트
npm run test:e2e    # 앱을 띄워 확인하는 테스트
npm run demo        # 가상 자료로 패널 열기
```
</details>
