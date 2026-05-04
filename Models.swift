import Foundation

// MARK: - Navigation Routes
enum AppRoute: Hashable {
    case recording
    case export
}

// MARK: - Event Codes
// Core lifecycle
let EVENT_CODES_CORE = [
    "START", "END", "PAUSE", "RESUME"
]
// Occlusion / visibility
let EVENT_CODES_OCCLUSION = [
    "CAR_OCCLUDED", "HUMAN_OCCLUDED", "WALL_CORNER", "VISIBLE", "DANGER_POINT"
]
// Movement
let EVENT_CODES_MOVEMENT = [
    "MOVE_START",
    "SIDEWALK_PARALLEL", "OPPOSITE_SIDEWALK", "CURB_WAITING",
    "LANE_ENTER", "LANE_EXIT",
    "CROSSWALK_APPROACH",
    "RIGHT_TURN_START", "RIGHT_TURN_CONFLICT",
    "ALLEY_ENTRY", "DART_OUT"
]
// VRU type-specific
let EVENT_CODES_VRU_TYPE = [
    "MOTORCYCLE_APPROACH", "BICYCLE_APPROACH", "SCOOTER_APPROACH"
]
// Carry position
let EVENT_CODES_CARRY = [
    "HELD_IN_HAND", "INSIDE_POCKET", "INSIDE_BAG", "BODY_SHADOWED"
]
// Cooperative warning
let EVENT_CODES_COOP = [
    "NODE_A_DETECTED", "NODE_B_WARNED",
    "COOP_MESSAGE_SENT", "COOP_MESSAGE_RECEIVED"
]
// Risk classification
let EVENT_CODES_RISK = [
    "FALSE_POSITIVE_CASE", "TRUE_DANGER_CASE"
]

// MARK: - Event Log
struct EventLog: Identifiable, Codable {
    var id: UUID = UUID()
    // Core fields
    var experimentId: String
    var scenario: String
    var target: String
    var location: String
    var timeS: Double
    var event: String
    var note: String
    // Extended schema fields (default to empty string)
    var roadType: String = ""
    var laneCount: String = ""
    var egoLane: String = ""
    var targetZone: String = ""
    var targetMotion: String = ""
    var occlusionState: String = ""
    var carryPosition: String = ""
    var riskLabel: String = ""
    var nodeId: String = ""
    var createdAt: Date = Date()
}

// MARK: - Experiment Session
struct ExperimentSession {
    var experimentId: String
    var scenario: String
    var target: String
    var location: String
    var memo: String
    // Extended setup fields
    var roadType: String
    var laneCount: String
    var egoLane: String
    var nodeId: String
    var startTime: Date
    var events: [EventLog] = []
}
