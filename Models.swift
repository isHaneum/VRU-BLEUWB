import Foundation

// MARK: - Navigation Routes
enum AppRoute: Hashable {
    case recording
    case export
}

// MARK: - Event Log
struct EventLog: Identifiable, Codable {
    var id: UUID = UUID()
    var experimentId: String
    var scenario: String
    var target: String
    var location: String
    var timeS: Double
    var event: String
    var note: String
    var createdAt: Date = Date()
}

// MARK: - Experiment Session
struct ExperimentSession {
    var experimentId: String
    var scenario: String
    var target: String
    var location: String
    var memo: String
    var startTime: Date
    var events: [EventLog] = []
}
