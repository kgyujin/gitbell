// 활동 한 줄. 세 줄로 나눠 한 줄에 정보를 몰지 않는다(좁은 폭에서 글자가 잘리던 문제).
// [종류]  저장소 #번호 (또는 ⎇ 브랜치)                       시간
//         본문 (PR 제목·댓글·커밋 제목, 최대 2줄)
//         종류 이름 · (아바타) 사람 [봇]                         ●
// 안 읽은 줄에 마우스를 올리면 ● 자리에 '읽음 표시' 단추가 나온다(열지 않고 읽음으로 바꾸기).

import GitBellCore
import SwiftUI

struct EventRow: View {
    let event: ActivityEvent
    /// 저장소별로 묶어 보일 때는 묶음 제목에 저장소가 있어 줄마다 다시 쓰지 않는다.
    var showsRepository = true
    /// 열지 않고 읽음으로 바꾸기. 없으면 단추를 보이지 않는다.
    var markRead: (() -> Void)?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                KindBadge(kind: event.kind)
                VStack(alignment: .leading, spacing: 3) {
                    contextLine
                    Text(L10n.title(event))
                        .font(.system(size: 13, weight: event.isUnread ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    actorLine
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.primary.opacity(hovering ? 0.06 : 0))
                    .padding(.horizontal, 6)
            )
        }
        .buttonStyle(.plain)
        // 단추를 줄(Button) 안에 넣으면 줄이 누름을 가져가서, 줄 위에 따로 얹는다.
        .overlay(alignment: .bottomTrailing) {
            if hovering, event.isUnread, let markRead {
                Button(action: markRead) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.tint)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L10n.string("Mark as read"))
                // 가운데가 ● 자리(오른쪽 14pt + 점 반지름)와 같게 둔다. 그래야 마우스를 올려도 옆으로 튀지 않는다.
                .padding(.trailing, 6.5)
                .padding(.bottom, 5)
            }
        }
        // 단추 위에 있어도 줄에 마우스가 있는 것으로 보도록 overlay 뒤에 단다.
        .onHover { hovering = $0 }
        .help(L10n.title(event))
        // VoiceOver는 제목부터, 무슨 일·누가·어디서·언제 순서로 읽는다('·' 같은 꾸밈 글자는 읽지 않는다).
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let what = [L10n.kindLabel(event), L10n.displayName(event.actor)].filter { !$0.isEmpty }.joined(separator: ", ")
        let place = [showsRepository ? event.repoName : "", L10n.target(event)].filter { !$0.isEmpty }.joined(separator: " ")
        return [L10n.title(event), what, place, L10n.relative(event.time), event.isUnread ? L10n.string("Unread") : ""]
            .filter { !$0.isEmpty }.joined(separator: ". ")
    }

    /// 저장소 이름은 가운데를 줄여 앞뒤가 보이게 하고, 시간은 항상 다 보인다.
    private var contextLine: some View {
        HStack(spacing: 4) {
            if showsRepository {
                Text(verbatim: event.repoName)
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
            }
            let target = L10n.target(event)
            if !target.isEmpty {
                Text(verbatim: target)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            // 패널을 열어 둔 동안에도 '3분 전' 같은 시간이 바뀌게 30초마다 다시 그린다.
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text(L10n.relative(event.time))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
    }

    private var actorLine: some View {
        HStack(spacing: 5) {
            Text(L10n.kindLabel(event))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(event.kind.tint)
                .lineLimit(1)
                .fixedSize()
            if !event.actor.isEmpty {
                Text(verbatim: "·").foregroundStyle(.tertiary)
                Avatar(url: event.actorAvatarURL)
                Text(verbatim: L10n.displayName(event.actor))
                    .lineLimit(1)
                    .truncationMode(.tail)
                if EventBuilder.isBot(event.actor) {
                    Text("bot")
                        .font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                        .fixedSize()
                }
            }
            Spacer(minLength: 6)
            // 마우스를 올리면 이 자리에 '읽음 표시' 단추가 겹쳐 나와 점은 숨긴다.
            if event.isUnread && !(hovering && markRead != nil) {
                Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                    .accessibilityLabel(Text("Unread"))
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
    }
}

private struct KindBadge: View {
    let kind: EventKind

    var body: some View {
        Image(systemName: kind.symbol)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(kind.tint)
            .frame(width: 28, height: 28)
            .background(Circle().fill(kind.tint.opacity(0.15)))
            .padding(.top, 1)
            .accessibilityHidden(true)
    }
}

private struct Avatar: View {
    let url: URL?
    @State private var image: NSImage?

    init(url: URL?) {
        self.url = url
        // 이미 받은 이미지는 첫 화면부터 바로 그린다(회색 원이 잠깐 보이지 않게).
        _image = State(initialValue: url.flatMap { AvatarCache.shared.cached($0) })
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Circle().fill(Color.secondary.opacity(0.25))
            }
        }
        .frame(width: 14, height: 14)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: url) {
            guard let url else { image = nil; return }
            if let cached = AvatarCache.shared.cached(url) { image = cached; return }
            image = nil
            image = await AvatarCache.shared.image(for: url)
        }
    }
}

/// 아바타 이미지를 메모리에 모아 둔다.
/// AsyncImage는 따로 모아 두지 않아, 목록을 스크롤해 줄이 다시 그려질 때마다 회색 원부터 보였다가 다시 받았다.
/// 같은 사람이 여러 줄에 나와도 한 번만 받는다(받는 중인 요청도 함께 쓴다).
@MainActor
final class AvatarCache {
    static let shared = AvatarCache()
    private let images = NSCache<NSURL, NSImage>()
    /// 받는 중인 요청. 이미지가 아니라 받은 바이트를 넘긴다(NSImage는 macOS 13에서 스레드 사이로 넘길 수 없다).
    private var loading: [URL: Task<Data?, Never>] = [:]

    private init() {
        // 40px 이미지라 한 장이 몇 KB다. 기록은 150개까지라 이 정도면 모두 들어간다.
        images.countLimit = 200
    }

    func cached(_ url: URL) -> NSImage? {
        images.object(forKey: Self.sized(url) as NSURL)
    }

    func image(for url: URL) async -> NSImage? {
        let sized = Self.sized(url)
        if let cached = images.object(forKey: sized as NSURL) { return cached }
        let task: Task<Data?, Never>
        if let running = loading[sized] {
            task = running
        } else {
            task = Task.detached {
                var request = URLRequest(url: sized, timeoutInterval: 15)
                request.setValue("GitBell", forHTTPHeaderField: "User-Agent")
                guard let (data, response) = try? await URLSession.shared.data(for: request),
                      (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
                return data
            }
            loading[sized] = task
        }
        let data = await task.value
        loading[sized] = nil
        if let cached = images.object(forKey: sized as NSURL) { return cached }
        guard let data, let image = NSImage(data: data) else { return nil }
        images.setObject(image, forKey: sized as NSURL)
        return image
    }

    /// GitHub 아바타 주소에 크기를 붙여 작은 이미지만 받는다.
    private static func sized(_ url: URL) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.append(URLQueryItem(name: "s", value: "40"))
        components?.queryItems = items
        return components?.url ?? url
    }
}
