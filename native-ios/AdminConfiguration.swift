import Foundation

struct AdminConfiguration: Decodable {
    let projectName: String
    let adminURL: URL

    static let current: AdminConfiguration = {
        guard
            let file = Bundle.main.url(forResource: "ProjectAdminConfig", withExtension: "json"),
            let data = try? Data(contentsOf: file),
            let config = try? JSONDecoder().decode(AdminConfiguration.self, from: data)
        else {
            preconditionFailure("ProjectAdminConfig.json is missing or invalid")
        }
        return config
    }()
}
