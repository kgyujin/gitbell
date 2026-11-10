// GitHub 토큰을 찾는다. 순서: 1) 사용자가 앱에 넣어 키체인에 저장한 토큰 2) GitHub CLI(gh) 로그인.
// 토큰 값은 화면·로그·파일에 남기지 않는다. 키체인 항목은 이 앱 서비스 이름으로만 읽고 쓴다.

import Foundation
import Security

public enum TokenSource: Equatable, Sendable {
    case keychain
    case githubCLI
}

public struct ResolvedToken: Sendable {
    public var value: String
    public var source: TokenSource
}

public enum TokenStore {
    static let service = "io.github.kgyujin.gitbell"
    static let account = "github-token"

    public static func resolve() -> ResolvedToken? {
        if let saved = readKeychain(), !saved.isEmpty { return ResolvedToken(value: saved, source: .keychain) }
        if let cli = readGitHubCLI(), !cli.isEmpty { return ResolvedToken(value: cli, source: .githubCLI) }
        return nil
    }

    // MARK: 키체인

    @discardableResult
    public static func save(_ token: String) -> Bool {
        deleteKeychain()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    public static func deleteKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public static var hasSavedToken: Bool { readKeychain() != nil }

    static func readKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: GitHub CLI

    /// 메뉴 막대 앱은 로그인 셸 PATH를 물려받지 못해 gh를 흔한 설치 경로에서 찾는다.
    static let ghCandidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
    static let ghTimeout: TimeInterval = 10

    public static func githubCLIPath() -> String? {
        ghCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func readGitHubCLI() -> String? {
        guard let gh = githubCLIPath() else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: gh)
        process.arguments = ["auth", "token"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        // gh가 키체인 잠금 해제 창 등을 기다리며 멈추면 확인 전체가 멈춘다. 10초 넘게 걸리면 끝내고 토큰 없음으로 본다
        // (Windows판도 같은 10초 제한을 둔다).
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            return nil
        }
        if finished.wait(timeout: .now() + ghTimeout) == .timedOut {
            process.terminate()
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
