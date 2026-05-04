import Foundation

class ExperimentStore: ObservableObject {

    // MARK: - Published State
    @Published var session: ExperimentSession?
    @Published var navigationPath: [AppRoute] = []

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
        navigationPath = [.recording]
    }

    func addEvent(code: String, note: String = "") {
        guard var s = session else { return }
        let elapsed = Date().timeIntervalSince(s.startTime)
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
            nodeId: s.nodeId
        )
        s.events.append(event)
        session = s

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
}
