import SwiftUI

struct SetupView: View {

    @EnvironmentObject var store: ExperimentStore

    @State private var experimentId = ""
    @State private var scenario = "S1 Alley Dart-out"
    @State private var target = "Pedestrian"
    @State private var location = "Parking Lot"
    @State private var roadType = "Urban Road"
    @State private var laneCount = "2"
    @State private var egoLane = "1"
    @State private var nodeId = "node_A"
    @State private var memo = ""

    private let scenarios = [
        "S1 Alley Dart-out",
        "S2 Right-turn Conflict",
        "S3 Four-lane Sidewalk FP",
        "S4 Lane-splitting Two-wheeler",
        "S5 Carry Position Degradation",
        "S6 Cooperative Warning",
        "No Obstacle",
        "Human Occlusion",
        "Vehicle Occlusion",
        "Wall / Corner"
    ]
    private let targets   = ["Pedestrian", "Bicycle", "Motorcycle", "Scooter", "Other"]
    private let locations = ["Parking Lot", "Narrow Alley", "Crosswalk", "Intersection", "Campus Road"]
    private let roadTypes = ["Urban Road", "4-lane Road", "Alley", "Parking Lot", "Campus"]
    private let laneCounts = ["1", "2", "4", "6"]
    private let egoLanes  = ["1", "2", "3", "4"]
    private let nodeIds   = ["node_A", "node_B", "node_C"]

    private var canStart: Bool {
        !experimentId.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {

                Text("Experiment Setup")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .foregroundColor(.black)

                // ── Experiment ID ──────────────────────────────────────────
                fieldGroup("Experiment ID") {
                    TextField("e.g. alley_dartout_01", text: $experimentId)
                        .textFieldStyle(.roundedBorder)
                        .foregroundColor(.black)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                // ── Scenario ───────────────────────────────────────────────
                fieldGroup("Scenario") {
                    VStack(spacing: 8) {
                        ForEach(scenarios, id: \.self) { s in
                            SelectionButton(label: s, isSelected: scenario == s) {
                                scenario = s
                            }
                        }
                    }
                }

                // ── Target ─────────────────────────────────────────────────
                fieldGroup("Target") {
                    compactGrid(targets, selected: $target)
                }

                // ── Location ───────────────────────────────────────────────
                fieldGroup("Location") {
                    compactGrid(locations, selected: $location)
                }

                // ── Road Type ──────────────────────────────────────────────
                fieldGroup("Road Type") {
                    compactGrid(roadTypes, selected: $roadType)
                }

                // ── Lane Count ─────────────────────────────────────────────
                fieldGroup("Lane Count") {
                    HStack(spacing: 8) {
                        ForEach(laneCounts, id: \.self) { l in
                            SelectionButton(label: l, isSelected: laneCount == l) {
                                laneCount = l
                            }
                        }
                    }
                }

                // ── Ego Lane ───────────────────────────────────────────────
                fieldGroup("Ego Lane (vehicle lane position)") {
                    HStack(spacing: 8) {
                        ForEach(egoLanes, id: \.self) { l in
                            SelectionButton(label: l, isSelected: egoLane == l) {
                                egoLane = l
                            }
                        }
                    }
                }

                // ── Node ID ────────────────────────────────────────────────
                fieldGroup("Logger Node ID") {
                    HStack(spacing: 8) {
                        ForEach(nodeIds, id: \.self) { n in
                            SelectionButton(label: n, isSelected: nodeId == n) {
                                nodeId = n
                            }
                        }
                    }
                }

                // ── Memo ───────────────────────────────────────────────────
                fieldGroup("Memo") {
                    TextField("Optional memo", text: $memo)
                        .textFieldStyle(.roundedBorder)
                        .foregroundColor(.black)
                }

                // ── Start Button ───────────────────────────────────────────
                Button(action: startExperiment) {
                    Text("Start Experiment")
                        .fontWeight(.bold)
                        .frame(maxWidth: .infinity)
                        .frame(height: 60)
                        .background(canStart ? Color.black : Color(white: 0.8))
                        .foregroundColor(canStart ? .white : Color(white: 0.5))
                        .cornerRadius(12)
                }
                .disabled(!canStart)
            }
            .padding()
        }
        .background(Color.white)
        .toolbar(.hidden, for: .navigationBar)
    }

    // MARK: - Helpers

    private func startExperiment() {
        store.startExperiment(
            experimentId: experimentId.trimmingCharacters(in: .whitespaces),
            scenario: scenario,
            target: target,
            location: location,
            memo: memo,
            roadType: roadType,
            laneCount: laneCount,
            egoLane: egoLane,
            nodeId: nodeId
        )
    }

    @ViewBuilder
    private func compactGrid(_ options: [String], selected: Binding<String>) -> some View {
        let columns = [GridItem(.flexible()), GridItem(.flexible())]
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(options, id: \.self) { opt in
                SelectionButton(label: opt, isSelected: selected.wrappedValue == opt) {
                    selected.wrappedValue = opt
                }
            }
        }
    }

    @ViewBuilder
    private func fieldGroup<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .fontWeight(.bold)
                .foregroundColor(.black)
            content()
        }
    }
}

// MARK: - Selection Button

private struct SelectionButton: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .fontWeight(isSelected ? .bold : .regular)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(isSelected ? Color.black : Color.white)
                .foregroundColor(isSelected ? .white : .black)
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.black, lineWidth: 1)
                )
        }
    }
}

