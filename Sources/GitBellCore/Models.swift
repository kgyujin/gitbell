// 앱 안에서 쓰는 활동 항목 모델과, GitHub REST API 응답 중 필요한 필드만 담는 디코딩 모델.
// GitHub API 시각은 UTC ISO 8601이며 Date로 바로 디코딩한다.

import Foundation

/// 활동 종류. 화면 문구는 앱 쪽에서 언어에 맞춰 만든다.
public enum EventKind: String, Codable, CaseIterable, Sendable {
    case prOpened, prMerged, prClosed
    case reviewApproved, reviewChangesRequested, reviewCommented
    case comment
    case push, forcePush, branchCreated

    public var category: EventCategory {
        switch self {
        case .prOpened, .prMerged, .prClosed: return .pullRequests
        case .reviewApproved, .reviewChangesRequested, .reviewCommented, .comment: return .reviews
        case .push, .forcePush, .branchCreated: return .commits
        }
    }

    public var isPush: Bool { category == .commits }
}

/// 화면 위쪽 필터에 쓰는 묶음.
public enum EventCategory: String, CaseIterable, Sendable {
    case pullRequests, reviews, commits
}

/// 메뉴에 보이는 활동 하나. id는 저장소마다 겹치지 않게 "owner/repo#종류:번호" 꼴이다.
public struct ActivityEvent: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var repo: String
    public var kind: EventKind
    public var time: Date
    public var actor: String
    public var actorAvatarURL: URL?
    /// PR·이슈 번호. push 종류에는 없다.
    public var number: Int?
    /// push 종류의 브랜치 이름.
    public var branch: String?
    /// PR 제목, 댓글 첫 줄, 커밋 제목 같은 본문 미리보기.
    public var title: String
    public var url: URL
    /// 댓글이 PR이 아니라 이슈에 달렸는지.
    public var isIssue: Bool
    /// push에 담긴 커밋 수. 커밋 제목을 읽은 뒤 채운다.
    public var commitCount: Int?
    public var before: String?
    public var after: String?
    /// push의 커밋 제목을 이미 읽었는지(실패해도 다시 읽지 않는다).
    public var detailResolved: Bool
    public var isUnread: Bool
    /// 이 활동이 일어난 PR을 올린 사람. '내 PR' 필터와 알림에 쓴다. 알 수 없으면 nil.
    /// 0.3.x 기록에는 없는 필드라 선택값으로 둔다(디코딩 시 없으면 nil).
    public var prAuthor: String?

    public var repoName: String { repo.split(separator: "/").last.map(String.init) ?? repo }

    public init(id: String, repo: String, kind: EventKind, time: Date, actor: String,
                actorAvatarURL: URL? = nil, number: Int? = nil, branch: String? = nil,
                title: String, url: URL, isIssue: Bool = false, commitCount: Int? = nil,
                before: String? = nil, after: String? = nil, detailResolved: Bool = true,
                isUnread: Bool = false, prAuthor: String? = nil) {
        self.id = id
        self.repo = repo
        self.kind = kind
        self.time = time
        self.actor = actor
        self.actorAvatarURL = actorAvatarURL
        self.number = number
        self.branch = branch
        self.title = title
        self.url = url
        self.isIssue = isIssue
        self.commitCount = commitCount
        self.before = before
        self.after = after
        self.detailResolved = detailResolved
        self.isUnread = isUnread
        self.prAuthor = prAuthor
    }
}

// MARK: - GitHub API 응답 (필요한 필드만)

public struct GHUser: Decodable, Sendable {
    public var login: String
    public var avatarUrl: URL?
}

public struct GHPull: Decodable, Sendable {
    public struct Head: Decodable, Sendable { public var ref: String }
    public var number: Int
    /// PR의 브랜치. 그 브랜치에 들어온 push가 누구 PR인지 찾는 데 쓴다.
    public var head: Head?
    public var title: String
    public var htmlUrl: URL
    public var user: GHUser?
    public var createdAt: Date?
    public var updatedAt: Date?
    public var mergedAt: Date?
    public var closedAt: Date?
    public var mergeCommitSha: String?
}

public struct GHReview: Decodable, Sendable {
    public var id: Int
    public var state: String
    public var body: String?
    public var user: GHUser?
    public var submittedAt: Date?
    public var htmlUrl: URL?
}

public struct GHReviewComment: Decodable, Sendable {
    public var id: Int
    public var pullRequestReviewId: Int?
    public var pullRequestUrl: String?
    public var user: GHUser?
    public var body: String?
    public var createdAt: Date?
    public var htmlUrl: URL?
}

public struct GHIssueComment: Decodable, Sendable {
    public var id: Int
    public var issueUrl: String?
    public var htmlUrl: URL?
    public var user: GHUser?
    public var body: String?
    public var createdAt: Date?
}

public struct GHActivity: Decodable, Sendable {
    public var id: Int
    public var activityType: String
    public var ref: String?
    public var before: String?
    public var after: String?
    public var actor: GHUser?
    public var timestamp: Date
}

public struct GHRepo: Decodable, Sendable {
    public var fullName: String
    public var pushedAt: Date?
    public var archived: Bool?
}

public struct GHNotification: Decodable, Sendable {
    public struct Repository: Decodable, Sendable { public var fullName: String }
    public var repository: Repository
    public var updatedAt: Date
}

public struct GHCommit: Decodable, Sendable {
    public struct Inner: Decodable, Sendable { public var message: String }
    public var commit: Inner
}

public struct GHCompare: Decodable, Sendable {
    public var totalCommits: Int?
    public var commits: [GHCommit]
}

/// 저장소 하나에서 항목을 만드는 데 필요한 원자료.
public struct RepoSnapshot: Sendable {
    public var pulls: [GHPull] = []
    public var reviewsByPR: [Int: [GHReview]] = [:]
    public var reviewComments: [GHReviewComment] = []
    public var issueComments: [GHIssueComment] = []
    public var activity: [GHActivity] = []

    public init(pulls: [GHPull] = [], reviewsByPR: [Int: [GHReview]] = [:],
                reviewComments: [GHReviewComment] = [], issueComments: [GHIssueComment] = [],
                activity: [GHActivity] = []) {
        self.pulls = pulls
        self.reviewsByPR = reviewsByPR
        self.reviewComments = reviewComments
        self.issueComments = issueComments
        self.activity = activity
    }
}

/// GitHub 응답을 디코딩하는 공용 디코더. 스네이크 표기와 ISO 8601 시각을 처리한다.
public enum GitHubJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
