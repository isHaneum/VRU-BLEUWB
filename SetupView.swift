import SwiftUI

struct SetupView: View {

    @EnvironmentObject var store: ExperimentStore

    @State private var experimentId = ""
    @State private var scenario = "No Obstacle"
    @State private var target = "Pedestrian"
    @State private var location = "Parking Lot"
    @State private var memo = ""

    private let scenarios = ["No Obstacle", "Human Occlusion", "Vehicle Occlusion", "Wall / Corner"]
    private let targets   = ["Pedestrian", "Bicycle"]
    private let locations = ["Parking Lot", "Narrow Alley"]

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
                    TextField("e.g. vehicle_occlusion_01", text: $experimentId)
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
                    HStack(spacing: 8) {
                        ForEach(targets, id: \.self) { t in
                            SelectionButton(label: t, isSelected: target == t) {
                                target = t
                            }
                        }
                    }
                }

                // ── Location ───────────────────────────────────────────────
                fieldGroup("Location") {
                    HStack(spacing: 8) {
                        ForEach(locations, id: \.self) { l in
                            SelectionButton(label: l, isSelected: location == l) {
                                location = l
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
            memo: memo
        )
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
