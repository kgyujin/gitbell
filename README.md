<div align="center">

<img src="docs/icon.png" alt="GitBell icon" width="96">

# GitBell

_Your GitHub activity, one click away in the Mac menu bar or the Windows system tray._

[![npm](https://img.shields.io/npm/v/gitbell?logo=npm)](https://www.npmjs.com/package/gitbell)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-black?logo=apple)](#macos)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows)](#windows)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Install](#install) · [Features](#features) · [Tips](#tips) · [How it checks GitHub](#how-it-checks-github) · [FAQ](#faq) · [한국어](README.ko.md)

<img src="docs/readme/hero-en.png" alt="GitBell on macOS (light) and Windows (dark), listing reviews, pull requests, pushes and comments" width="820">

</div>

GitBell shows new **pull requests, reviews, comments, merges and commits** from every repository you can access, and notifies you when something happens. Nothing to set up on the repository side: no bots, no webhooks.

## See it in action

<table>
<tr>
<td align="center" width="50%"><b>Windows</b><br><img src="docs/readme/demo-windows-en.gif" alt="Hovering a row to mark it read, filtering, searching, sorting by repository, the right-click menu and settings" width="400"></td>
<td align="center" width="50%"><b>macOS</b><br><img src="docs/readme/demo-mac-en.gif" alt="The list, unread first, by repository, Mine, the undo and update banners, and settings" width="400"></td>
</tr>
</table>

## Install

### macOS

```bash
npx gitbell
```

GitBell builds on your Mac, installs to `~/Applications`, and starts. Click the bell in the menu bar.

> [!NOTE]
> Needs macOS 13 or later, Node.js 18+, and the Xcode command line tools with Swift 5.10 or later (`xcode-select --install`). Because the app is built on your own Mac, macOS opens it without the "unidentified developer" warning.

### Windows

Run the same command in PowerShell or Command Prompt. If PowerShell says running scripts is disabled, run `npx.cmd gitbell` instead.

```powershell
npx gitbell
```

GitBell installs to `%LOCALAPPDATA%\Programs\GitBell`, adds a Start menu shortcut, and starts. Click the bell in the system tray next to the clock. If you don't see it, open the **^** overflow menu and drag the bell onto the taskbar.

> [!NOTE]
> Needs Windows 10 or later and Node.js 22.12+. The first install downloads Electron (about 100 MB). Your token is encrypted for your Windows account and stays on this PC; settings and history live in `%APPDATA%\GitBell`.

### Connect GitHub

<img src="docs/readme/windows-onboarding-en.png" alt="The Connect your GitHub account screen" width="360" align="right">

If you use [GitHub CLI](https://cli.github.com), there's nothing to do: GitBell uses your `gh` login.

Otherwise, paste a [personal access token](https://github.com/settings/tokens/new?scopes=repo,notifications,read:org&description=GitBell) with `repo`, `notifications` and `read:org` into the app.

> [!TIP]
> Fine-grained tokens can't read notifications. GitBell still works with them, but it then checks only repositories with recent pushes.

<br clear="right">

## Features

<table>
<tr>
<td width="50%" valign="top">

**One list for everything.** PRs opened, merged or closed, approvals, change requests, comments, pushes and new branches. Hover an unread item to mark it read without opening it.

</td>
<td width="50%" valign="top">

**Find things fast.** Filter by type, repository, unread or **Mine** (others' activity on your PRs), and search titles, people and `#numbers`.

</td>
</tr>
<tr>
<td><img src="docs/readme/mac-repo-en.png" alt="Items grouped by repository, each group with Mark as read" width="380"></td>
<td><img src="docs/readme/windows-search-en.png" alt="Searching for contrast narrows the list to two items" width="380"></td>
</tr>
<tr>
<td width="50%" valign="top">

**Less noise.** Your own activity is hidden by default. Right-click an item to copy its link, mark it unread, show only that repository, or hide it.

</td>
<td width="50%" valign="top">

**Notifications you control.** Native banners with optional sound. Turn each type on or off, or only hear about pull requests you opened.

</td>
</tr>
<tr>
<td><img src="docs/readme/windows-menu-en.png" alt="Right-click menu: Open in browser, Copy link, Mark as read, Show only web, Hide web" width="380"></td>
<td><img src="docs/readme/mac-settings-en.png" alt="Settings: notification types, list options and check interval" width="380"></td>
</tr>
<tr>
<td width="50%" valign="top">

**Undo and updates.** Marked a whole group as read by mistake? Undo it with <kbd>⌘</kbd> <kbd>Z</kbd> / <kbd>Ctrl</kbd> <kbd>Z</kbd>. A banner tells you when a new version is out and copies the update command.

</td>
<td width="50%" valign="top">

**Sort your way.** Newest first, by repository, or unread first. Pick one repository from the menu; unread counts show next to each name.

</td>
</tr>
<tr>
<td><img src="docs/readme/mac-banners-en.png" alt="Undo banner and new version banner above the footer" width="380"></td>
<td><img src="docs/readme/windows-repos-en.png" alt="Repository menu with unread and total counts" width="380"></td>
</tr>
</table>

GitBell follows your system's light or dark appearance and language (English or Korean), and works with the keyboard and screen readers (VoiceOver, Narrator).

## Tips

| Do this | How |
| --- | --- |
| Search | <kbd>⌘</kbd> <kbd>F</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>F</kbd>) |
| Refresh now | <kbd>⌘</kbd> <kbd>R</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>R</kbd>) |
| Open settings | <kbd>⌘</kbd> <kbd>,</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>,</kbd>) |
| Undo "Mark as read" | <kbd>⌘</kbd> <kbd>Z</kbd> (Windows: <kbd>Ctrl</kbd> <kbd>Z</kbd>) |
| Copy link, mark unread, hide a repository | Right-click an item (Windows keyboard: <kbd>Shift</kbd> <kbd>F10</kbd>) |
| Mark a whole repository as read | Sort **By repository**, then **Mark as read** on its header |
| Close search, settings or the panel | <kbd>Esc</kbd> |

## How it checks GitHub

GitBell checks every few minutes (1, 2, 5, 10 or 15; default 2) and tries hard not to use up your [API rate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):

- **Only what changed.** A repository is read right away when it gets a push or a notification. Quiet repositories are checked again every 15 minutes.
- **Conditional requests.** Unchanged responses come back as `304 Not Modified`, which GitHub doesn't count against your limit.
- **Backs off.** When few requests are left, GitBell skips optional work; when the limit is reached, it waits until it resets.
- **Nothing lost.** If a repository can't be read for a moment, the next check picks up from where it failed.

> [!NOTE]
> GitBell talks only to GitHub, plus npm once an hour to check for updates. Your token stays on your computer: in the macOS Keychain, or encrypted for your Windows account.

## Update and uninstall

```bash
npx gitbell@latest                  # update
npx gitbell uninstall               # remove the app, keep settings
npx gitbell uninstall --purge       # also remove settings, history and the saved token
```

When a new version is out, a banner appears at the top of the panel, plus a notification if notifications are on. Click it to copy the update command.

On Windows you can also remove GitBell like any other app: **Settings → Apps → Installed apps → GitBell → Uninstall**, or right-click the tray icon and choose **Uninstall GitBell…**. Tick the box in the dialog to delete your settings and saved token too.

## FAQ

<details>
<summary><b>A repository is missing.</b></summary>

GitBell checks repositories with a push in the last 3 days, plus any repository with new GitHub notifications. Quiet repositories show up as soon as something happens in them. Check that you aren't set to **Ignore** for the repository on GitHub, and that it isn't in **Settings → Hidden repositories**.

For organizations that use SAML single sign-on, authorize your token for the organization: run `gh auth refresh`, or use **Configure SSO** next to your token on GitHub.
</details>

<details>
<summary><b>I don't see notification banners.</b></summary>

Open **Settings → Notifications** in GitBell and press **Send test**. If nothing appears, open **System Settings → Notifications → GitBell**, allow notifications, and choose **Banners** or **Alerts**. Focus modes also hide banners.

On Windows, use **Settings → Notifications → Open Windows settings** and check that GitBell notifications are on. Do not disturb (Focus assist) also hides banners.
</details>

<details>
<summary><b>Something shows up a few minutes late.</b></summary>

Pushes and anything that reaches your GitHub notifications appear on the next check. Activity in repositories you don't watch (for example a comment in an organization repository) can take up to 15 minutes, because quiet repositories are checked less often to save your API limit. Press <kbd>⌘</kbd> <kbd>R</kbd> / <kbd>Ctrl</kbd> <kbd>R</kbd> to check now.
</details>

<details>
<summary><b>How do I build it from source?</b></summary>

```bash
git clone https://github.com/kgyujin/gitbell && cd gitbell
swift test && scripts/build-app.sh   # creates dist/GitBell.app
```

The Windows version is the Electron app in `windows/`.

```bash
cd windows && npm install
npm test            # unit tests
npm run test:e2e    # tests that launch the app
npm run demo        # open the panel with sample data
```
</details>
