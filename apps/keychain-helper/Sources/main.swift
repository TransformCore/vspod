import Foundation
import Security

private struct Request: Decodable {
    let operation: String
    let account: String
    let value: String?
}

private struct Response: Encodable {
    let ok: Bool
    let found: Bool?
    let value: String?
}

private let service = "com.vspod.identity"

private func emit(_ response: Response) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response),
          let output = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false}")
        return
    }
    print(output)
}

func run() {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 64 * 1024,
          let request = try? JSONDecoder().decode(Request.self, from: input),
          request.account.range(of: "^[A-Za-z0-9._:@-]{1,200}$", options: .regularExpression) != nil else {
        emit(Response(ok: false, found: nil, value: nil))
        return
    }

    let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: request.account,
    ]

    switch request.operation {
    case "get":
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            emit(Response(ok: true, found: false, value: nil))
        } else if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) {
            emit(Response(ok: true, found: true, value: value))
        } else {
            emit(Response(ok: false, found: nil, value: nil))
        }
    case "set":
        guard let value = request.value, let data = value.data(using: .utf8) else {
            emit(Response(ok: false, found: nil, value: nil))
            return
        }
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            emit(Response(ok: SecItemAdd(add as CFDictionary, nil) == errSecSuccess, found: nil, value: nil))
        } else {
            emit(Response(ok: status == errSecSuccess, found: nil, value: nil))
        }
    case "delete":
        let status = SecItemDelete(base as CFDictionary)
        emit(Response(ok: status == errSecSuccess || status == errSecItemNotFound, found: nil, value: nil))
    default:
        emit(Response(ok: false, found: nil, value: nil))
    }
}

run()
