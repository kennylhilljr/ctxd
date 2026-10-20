import Foundation
import LocalAuthentication
import Security

let service = "dev.ctxd.sealed-pool"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else { fail("usage: ctxd-keyhelper create|get|remove <pool-id>") }
let action = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
guard account.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { fail("invalid pool id") }

let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch action {
case "create":
    var bytes = Data(count: 32)
    let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard status == errSecSuccess else { fail("random key generation failed: \(status)") }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &error) else {
        fail("access control creation failed")
    }
    var query = base
    query[kSecValueData as String] = bytes
    query[kSecAttrAccessControl as String] = access
    let add = SecItemAdd(query as CFDictionary, nil)
    guard add == errSecSuccess || add == errSecDuplicateItem else { fail("key creation failed: \(add)") }
    if add == errSecDuplicateItem {
        var get = base
        get[kSecReturnData as String] = true
        get[kSecUseOperationPrompt as String] = "Unlock sealed ctxd pool"
        var result: CFTypeRef?
        guard SecItemCopyMatching(get as CFDictionary, &result) == errSecSuccess, let existing = result as? Data else { fail("existing key could not be read") }
        bytes = existing
    }
    print(bytes.base64EncodedString())
case "get":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecUseOperationPrompt as String] = "Unlock sealed ctxd pool"
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { fail("key lookup failed: \(status)") }
    print(data.base64EncodedString())
case "remove":
    let status = SecItemDelete(base as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail("key removal failed: \(status)") }
default:
    fail("unknown action")
}
