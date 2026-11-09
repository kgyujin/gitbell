// 활동 한 줄. 세 줄로 나눠 한 줄에 정보를 몰지 않는다(좁은 폭에서 글자가 잘리던 문제).
// [종류]  저장소 #번호 (또는 ⎇ 브랜치)                       시간
//         본문 (PR 제목·댓글·커밋 제목, 최대 2줄)
//         종류 이름 · (아바타) 사람 [봇]                         ●

import GitBellCore
import SwiftUI

struct EventRow: View {
    let event: ActivityEvent
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
        .onHover { hovering = $0 }
        .help(L10n.title(event))
    }

    /// 저장소 이름은 가운데를 줄여 앞뒤가 보이게 하고, 시간은 항상 다 보인다.
    private var contextLine: some View {
        HStack(spacing: 4) {
            Text(verbatim: event.repoName)
                .fontWeight(.medium)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            let target = L10n.target(event)
            if !target.isEmpty {
                Text(verbatim: target)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            Text(L10n.relative(event.time))
                .lineLimit(1)
                .fixedSize()
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
            if event.isUnread {
                Circle().fill(Color.accentColor).frame(width: 7, height: 7)
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
    }
}

private struct Avatar: View {
    let url: URL?

    var body: some View {
        AsyncImage(url: url.map(sized)) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Circle().fill(Color.secondary.opacity(0.25))
        }
        .frame(width: 14, height: 14)
        .clipShape(Circle())
    }

    /// GitHub 아바타 주소에 크기를 붙여 작은 이미지만 받는다.
    private func sized(_ url: URL) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.append(URLQueryItem(name: "s", value: "40"))
        components?.queryItems = items
        return components?.url ?? url
    }
}
