// 저장소 원자료(RepoSnapshot)를 활동 항목으로 바꾼다. 부수 효과가 없는 순수 함수만 둔다.
//
// 규칙
// - since 이후에 생긴 것만 만든다. 같은 사건은 항상 같은 id가 나와서 중복을 거를 수 있다.
// - 머지된 PR은 '닫힘'으로 또 만들지 않는다. 머지한 사람은 저장소 활동의 pr_merge에서 찾는다.
// - 빈 COMMENTED 리뷰는 인라인 댓글·답글을 감싼 껍데기라 건너뛰고, 그 댓글을 항목으로 만든다.
//   본문이 있는 리뷰에 딸린 인라인 댓글은 리뷰 항목과 겹치므로 뺀다.
// - push는 저장소 Activity API로 읽는다(GitHub 알림함에는 push 알림이 없다).
//   pr_merge(PR 머지와 겹침), 브랜치 삭제(머지 뒤 정리), 봇 push(배포 등 잡음)는 뺀다.

import Foundation

public enum EventBuilder {
    public static let zeroSHA = String(repeating: "0", count: 40)

    public static func isBot(_ login: String) -> Bool { login.hasSuffix("[bot]") }

    public static func build(_ raw: RepoSnapshot, repo: String, since: Date) -> [ActivityEvent] {
        var events: [ActivityEvent] = []
        let repoURL = URL(string: "https://github.com/\(repo)")!
        func recent(_ date: Date?) -> Bool { date.map { $0 >= since } ?? false }
        func id(_ suffix: String) -> String { "\(repo)#\(suffix)" }

        var mergerBySHA: [String: GHUser] = [:]
        for item in raw.activity where item.activityType == "pr_merge" {
            if let after = item.after, let actor = item.actor { mergerBySHA[after] = actor }
        }

        for pull in raw.pulls {
            if recent(pull.createdAt), let created = pull.createdAt {
                events.append(ActivityEvent(
                    id: id("pr-open:\(pull.number)"), repo: repo, kind: .prOpened, time: created,
                    actor: pull.user?.login ?? "", actorAvatarURL: pull.user?.avatarUrl,
                    number: pull.number, title: pull.title, url: pull.htmlUrl))
            }
            if recent(pull.mergedAt), let merged = pull.mergedAt {
                let merger = pull.mergeCommitSha.flatMap { mergerBySHA[$0] }
                events.append(ActivityEvent(
                    id: id("pr-merged:\(pull.number)"), repo: repo, kind: .prMerged, time: merged,
                    actor: merger?.login ?? "", actorAvatarURL: merger?.avatarUrl,
                    number: pull.number, title: pull.title, url: pull.htmlUrl))
            } else if recent(pull.closedAt), let closed = pull.closedAt {
                events.append(ActivityEvent(
                    id: id("pr-closed:\(pull.number)"), repo: repo, kind: .prClosed, time: closed,
                    actor: "", number: pull.number, title: pull.title, url: pull.htmlUrl))
            }
        }

        var reviewIDsShown = Set<Int>()
        for (number, reviews) in raw.reviewsByPR {
            for review in reviews {
                guard recent(review.submittedAt), let submitted = review.submittedAt else { continue }
                let body = TextPreview.firstLine(review.body)
                let kind: EventKind
                switch review.state {
                case "APPROVED": kind = .reviewApproved
                case "CHANGES_REQUESTED": kind = .reviewChangesRequested
                case "COMMENTED" where !body.isEmpty: kind = .reviewCommented
                default: continue
                }
                reviewIDsShown.insert(review.id)
                events.append(ActivityEvent(
                    id: id("review:\(review.id)"), repo: repo, kind: kind, time: submitted,
                    actor: review.user?.login ?? "", actorAvatarURL: review.user?.avatarUrl,
                    number: number, title: body,
                    url: review.htmlUrl ?? repoURL.appendingPathComponent("pull/\(number)")))
            }
        }

        for comment in raw.reviewComments {
            guard recent(comment.createdAt), let created = comment.createdAt else { continue }
            if let reviewID = comment.pullRequestReviewId, reviewIDsShown.contains(reviewID) { continue }
            events.append(ActivityEvent(
                id: id("rc:\(comment.id)"), repo: repo, kind: .comment, time: created,
                actor: comment.user?.login ?? "", actorAvatarURL: comment.user?.avatarUrl,
                number: numberFromURL(comment.pullRequestUrl),
                title: TextPreview.firstLine(comment.body), url: comment.htmlUrl ?? repoURL))
        }

        for comment in raw.issueComments {
            guard recent(comment.createdAt), let created = comment.createdAt else { continue }
            let isIssue = !(comment.htmlUrl?.absoluteString.contains("/pull/") ?? false)
            events.append(ActivityEvent(
                id: id("ic:\(comment.id)"), repo: repo, kind: .comment, time: created,
                actor: comment.user?.login ?? "", actorAvatarURL: comment.user?.avatarUrl,
                number: numberFromURL(comment.issueUrl), title: TextPreview.firstLine(comment.body),
                url: comment.htmlUrl ?? repoURL, isIssue: isIssue))
        }

        for item in raw.activity {
            let actor = item.actor?.login ?? ""
            guard item.timestamp >= since, !isBot(actor) else { continue }
            let kind: EventKind
            switch item.activityType {
            case "push": kind = .push
            case "force_push": kind = .forcePush
            case "branch_creation": kind = .branchCreated
            default: continue
            }
            let branch = (item.ref ?? "").replacingOccurrences(of: "refs/heads/", with: "")
            let before = item.before ?? ""
            let after = item.after ?? ""
            let url: URL
            switch kind {
            case .push: url = repoURL.appendingPathComponent("compare/\(before)...\(after)")
            case .forcePush: url = repoURL.appendingPathComponent("commit/\(after)")
            default: url = repoURL.appendingPathComponent("tree/\(branch)")
            }
            events.append(ActivityEvent(
                id: id("act:\(item.id)"), repo: repo, kind: kind, time: item.timestamp,
                actor: actor, actorAvatarURL: item.actor?.avatarUrl, branch: branch, title: "",
                url: url, before: before, after: after, detailResolved: false))
        }

        return events.sorted { $0.time < $1.time }
    }

    static func numberFromURL(_ url: String?) -> Int? {
        guard let tail = url?.split(separator: "/").last else { return nil }
        return Int(tail)
    }
}
