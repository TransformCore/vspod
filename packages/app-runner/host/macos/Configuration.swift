import AppKit

struct HostConfiguration: Decodable {
    struct Policy: Decodable {
        let clipboard: Bool
        let files: Bool
        let externalUrls: Bool
    }
    let version: Int
    let container: String
    let root: String
    let bridge: [String]
    let `protocol`: String
    let integrations: Policy
    let stopGuestOnQuit: Bool

    static func read(_ path: String) -> HostConfiguration {
        do {
            let url = URL(fileURLWithPath: path)
            for candidate in [url.deletingLastPathComponent(), url] {
                let info = try FileManager.default.attributesOfItem(atPath: candidate.path)
                guard (info[.type] as? FileAttributeType) != .typeSymbolicLink,
                      let mode = info[.posixPermissions] as? UInt, mode & 0o077 == 0,
                      let owner = info[.ownerAccountID] as? UInt, owner == getuid() else {
                    fail("Host configuration must be private and owned by the current user")
                }
            }
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? UInt, size <= 16384 else {
                fail("Host configuration must be a regular file of at most 16 KiB")
            }
            let data = try Data(contentsOf: url)
            guard data.count <= 16384 else { fail("Oversized host configuration") }
            let value = try JSONDecoder().decode(HostConfiguration.self, from: data)
            guard value.version == 1, ["wayland", "x11"].contains(value.protocol) else {
                fail("Unsupported host configuration version or protocol")
            }
            guard value.container.range(of: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$", options: .regularExpression) != nil else {
                fail("Invalid host configuration container")
            }
            guard URL(fileURLWithPath: value.root).resolvingSymlinksInPath().path ==
                    url.deletingLastPathComponent().resolvingSymlinksInPath().path else {
                fail("Host configuration root does not match its private directory")
            }
            guard value.bridge == (value.protocol == "wayland"
                    ? ["/opt/app-runner/vspod-compositor", "--bridge"]
                    : ["python3", "/opt/window-capture/agent.py"]) else {
                fail("Invalid host configuration bridge")
            }
            return value
        } catch { fail("Host configuration: \(error)") }
    }
}
