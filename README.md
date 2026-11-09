<div align="center">

<img src="docs/icon.png" alt="GitBell icon" width="96">

# GitBell

_Your GitHub activity, one click away in the Mac menu bar._

[![npm](https://img.shields.io/npm/v/gitbell?logo=npm)](https://www.npmjs.com/package/gitbell)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-black?logo=apple)](#requirements)
[![Swift](https://img.shields.io/badge/Swift-5.10%2B-F05138?logo=swift&logoColor=white)](Package.swift)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Install](#install) · [Features](#features) · [How it works](#how-it-works) · [FAQ](#faq) · [한국어](README.ko.md)

<img src="docs/screenshot-en.png" alt="GitBell panel showing pull requests, reviews, merges and commits" width="420">

</div>

GitBell shows new **pull requests, reviews, comments, merges and commits** from every repository you can access, right in your menu bar. No Slack bot, no webhooks, nothing to set up on the repository side.

## Install

```bash
npx gitbell
```

That's it. The installer builds GitBell on your Mac, puts it in `~/Applications`, and starts it. Look for the bell in your menu bar.

> [!NOTE]
> Building on your own Mac means macOS opens the app without the "unidentified developer" warning. The first build takes about a minute. You need the Xcode command line tools (`xcode-select --install`).

**Connect GitHub.** If you already use [GitHub CLI](https://cli.github.com), you're done: GitBell uses your `gh` login. Otherwise, paste a [personal access token](https://github.com/settings/tokens/new?scopes=repo,notifications,read:org&description=GitBell) with the `repo`, `notifications` and `read:org` scopes.

## Features

- **Everything in one list.** Opened, merged and closed PRs, approvals, change requests, comments, pushes and new branches, across all your repositories.
- **Native notifications.** Click one to jump straight to the pull request or commit.
- **Quick filters.** All, PRs, Reviews, Commits. Unread items get a dot and a count on the bell.
- **Quiet by default.** Your own activity and bot deploy pushes are hidden, so the list shows what others did.
- **Private.** Talks only to the GitHub API. Your token stays in the macOS Keychain.
- **English and Korean.** Follows your macOS language.

## How it works

GitBell checks GitHub every 2 minutes (1 to 15, your choice). Reading 100+ repositories each time would hit the API limit, so it only reads repositories that **moved**:

| Picked when | Catches |
| --- | --- |
| Pushed to in the last 3 days | commits, new PRs, merges |
| New item in your GitHub notifications | comments and reviews on quieter repositories |

A typical check makes 10 to 20 API calls, well under GitHub's 5,000 per hour.

> [!TIP]
> On first launch GitBell fills the last 24 hours as already read, so you don't get a burst of old notifications.

## Uninstall

```bash
npx gitbell uninstall           # remove the app
npx gitbell uninstall --purge   # also remove settings, history and the saved token
```

## FAQ

<details>
<summary><b>A repository is missing.</b></summary>

GitBell reads repositories you own, collaborate on, or reach through an organization. Comments on a repository with no recent pushes show up only if you watch it on GitHub. If you set a repository to **Ignore**, GitHub sends no notifications for it.
</details>

<details>
<summary><b>I don't see notification banners.</b></summary>

Open **System Settings → Notifications → GitBell** and turn on **Allow notifications**. Also check that **Settings → Show notifications** is on in GitBell.
</details>

<details>
<summary><b>Can I build it myself?</b></summary>

```bash
git clone https://github.com/kgyujin/gitbell && cd gitbell
swift test                 # run the tests
scripts/build-app.sh       # builds dist/GitBell.app
```

To render the panel to an image with sample data: `dist/GitBell.app/Contents/MacOS/GitBell --snapshot out.png --demo [--dark]`.
</details>

## Requirements

- macOS 13 Ventura or later
- Xcode command line tools (for the install build)
- Node.js 18+ (for `npx`)
