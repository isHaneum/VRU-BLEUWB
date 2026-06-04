import Foundation

class ExperimentStore: ObservableObject {

    // MARK: - Published State
    @Published var session: ExperimentSession?
    @Published var navigationPath: [AppRoute] = []
    @Published var advertiser = BLEAdvertiser()

    // MARK: - Experiment Lifecycle

    func startExperiment(
        experimentId: String,
        scenario: String,
        target: String,
        location: String,
        memo: String,
        roadType: String = "",
        laneCount: String = "",
        egoLane: String = "",
        nodeId: String = ""
    ) {
        let startTime = Date()
        let baselineOcclusion = baselineOcclusionState(for: scenario)
        let startEvent = EventLog(
            experimentId: experimentId,
            scenario: scenario,
            target: target,
            location: location,
            timeS: 0.0,
            event: "START",
            note: "",
            roadType: roadType,
            laneCount: laneCount,
            egoLane: egoLane,
            occlusionState: baselineOcclusion,
            nodeId: nodeId
        )
        session = ExperimentSession(
            experimentId: experimentId,
            scenario: scenario,
            target: target,
            location: location,
            memo: memo,
            roadType: roadType,
            laneCount: laneCount,
            egoLane: egoLane,
            nodeId: nodeId,
            startTime: startTime,
            events: [startEvent]
        )
        advertiser.startAdvertising(experimentId: experimentId, nodeId: nodeId, eventCode: startEvent.event)
        navigationPath = [.recording]
    }

    func addEvent(code: String, note: String = "") {
        guard var s = session else { return }
        let elapsed = Date().timeIntervalSince(s.startTime)
        let derived = eventMetadata(for: code, scenario: s.scenario)
        let event = EventLog(
            experimentId: s.experimentId,
            scenario: s.scenario,
            target: s.target,
            location: s.location,
            timeS: elapsed,
            event: code,
            note: note,
            roadType: s.roadType,
            laneCount: s.laneCount,
            egoLane: s.egoLane,
            targetZone: derived.targetZone,
            targetMotion: derived.targetMotion,
            occlusionState: derived.occlusionState,
            carryPosition: derived.carryPosition,
            riskLabel: derived.riskLabel,
            nodeId: s.nodeId
        )
        s.events.append(event)
        session = s
        advertiser.startAdvertising(experimentId: s.experimentId, nodeId: s.nodeId, eventCode: event.event)

        if code == "END" && !navigationPath.contains(.export) {
            navigationPath.append(.export)
        }
    }

    func undoLastEvent() {
        guard var s = session, s.events.count > 1 else { return }
        s.events.removeLast()
        session = s
    }

    func resetEvents() {
        guard var s = session, let first = s.events.first else { return }
        s.events = [first]
        session = s
    }

    func newExperiment() {
        advertiser.stopAdvertising()
        session = nil
        navigationPath = []
    }

    // MARK: - CSV Export

    func generateCSV() -> String {
        guard let s = session else { return "" }
        var lines = ["experiment_id,scenario,target,location,time_s,event,note,road_type,lane_count,ego_lane,target_zone,target_motion,occlusion_state,carry_position,risk_label,node_id"]
        for e in s.events {
            let parts = [
                csvEscape(e.experimentId),
                csvEscape(e.scenario),
                csvEscape(e.target),
                csvEscape(e.location),
                String(format: "%.3f", e.timeS),
                csvEscape(e.event),
                csvEscape(e.note),
                csvEscape(e.roadType),
                csvEscape(e.laneCount),
                csvEscape(e.egoLane),
                csvEscape(e.targetZone),
                csvEscape(e.targetMotion),
                csvEscape(e.occlusionState),
                csvEscape(e.carryPosition),
                csvEscape(e.riskLabel),
                csvEscape(e.nodeId)
            ]
            lines.append(parts.joined(separator: ","))
        }
        return lines.joined(separator: "\n")
    }

    func csvFileName() -> String {
        guard let s = session else { return "export.csv" }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        let dateStr = formatter.string(from: s.startTime)
        let safeId = s.experimentId
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return "\(safeId)_\(dateStr).csv"
    }

    private func csvEscape(_ field: String) -> String {
        let needsQuoting = field.contains(",")
            || field.contains("\"")
            || field.contains("\n")
            || field.contains("\r")
        if needsQuoting {
            return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return field
    }

    private func baselineOcclusionState(for scenario: String) -> String {
        let normalized = scenario.uppercased()

        if normalized.contains("VISIBLE") || normalized.contains("NO OBSTACLE") {
            return "Visible / No Obstacle"
        }
        if normalized.contains("HUMAN OCCLUSION") {
            return "Human Occlusion"
        }
        if normalized.contains("VEHICLE OCCLUSION") || normalized.contains("METAL") {
            return "Metal / Vehicle Occlusion"
        }
        if normalized.contains("WALL") || normalized.contains("CORNER") {
            return "Wall / Corner"
        }

        return ""
    }

    private func eventMetadata(for code: String, scenario: String) -> (
        targetZone: String,
        targetMotion: String,
        occlusionState: String,
        carryPosition: String,
        riskLabel: String
    ) {
        let baselineOcclusion = baselineOcclusionState(for: scenario)

        switch code {
        case "METAL_OCCLUDED", "CAR_OCCLUDED":
            return ("", "", "Metal / Vehicle Occlusion", "", "")
        case "HUMAN_OCCLUDED":
            return ("", "", "Human Occlusion", "", "")
        case "WALL_CORNER":
            return ("", "", "Wall / Corner", "", "")
        case "VISIBLE":
            return ("", "", "Visible / No Obstacle", "", "")
        case "MOVE_START":
            return ("", "Move Start", baselineOcclusion, "", "")
        case "SIDEWALK_PARALLEL":
            return ("Sidewalk", "Parallel", baselineOcclusion, "", "")
        case "OPPOSITE_SIDEWALK":
            return ("Sidewalk", "Opposite Side", baselineOcclusion, "", "")
        case "CURB_WAITING":
            return ("Curb", "Waiting", baselineOcclusion, "", "")
        case "LANE_ENTER":
            return ("Lane", "Enter", baselineOcclusion, "", "")
        case "LANE_EXIT":
            return ("Lane", "Exit", baselineOcclusion, "", "")
        case "CROSSWALK_APPROACH":
            return ("Crosswalk", "Approach", baselineOcclusion, "", "")
        case "RIGHT_TURN_START":
            return ("Intersection", "Right Turn Start", baselineOcclusion, "", "")
        case "RIGHT_TURN_CONFLICT":
            return ("Intersection", "Right Turn Conflict", baselineOcclusion, "", "")
        case "ALLEY_ENTRY":
            return ("Alley", "Entry", baselineOcclusion, "", "")
        case "DART_OUT":
            return ("Road Edge", "Dart Out", baselineOcclusion, "", "")
        case "MOTORCYCLE_APPROACH":
            return ("", "Motorcycle Approach", baselineOcclusion, "", "")
        case "BICYCLE_APPROACH":
            return ("", "Bicycle Approach", baselineOcclusion, "", "")
        case "SCOOTER_APPROACH":
            return ("", "Scooter Approach", baselineOcclusion, "", "")
        case "HELD_IN_HAND":
            return ("", "", baselineOcclusion, "Hand", "")
        case "INSIDE_POCKET":
            return ("", "", baselineOcclusion, "Pocket", "")
        case "INSIDE_BAG":
            return ("", "", baselineOcclusion, "Bag", "")
        case "BODY_SHADOWED":
            return ("", "", baselineOcclusion, "Body Shadowed", "")
        case "DANGER_POINT":
            return ("", "", baselineOcclusion, "", "Danger Point")
        case "FALSE_POSITIVE_CASE":
            return ("", "", baselineOcclusion, "", "False Positive")
        case "TRUE_DANGER_CASE":
            return ("", "", baselineOcclusion, "", "True Danger")
        default:
            return ("", "", baselineOcclusion, "", "")
        }
    }
}
