import Foundation

enum AdminAccessRole: String, Equatable {
    case admin
    case collaborator
}

enum AdminAccessPolicy {
    static func role(record: [String: Any]?, emailVerified: Bool) -> AdminAccessRole? {
        guard emailVerified, record?["active"] as? Bool == true,
              let rawRole = record?["role"] as? String else { return nil }
        return AdminAccessRole(rawValue: rawRole)
    }
}
