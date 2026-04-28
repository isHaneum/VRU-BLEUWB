import SwiftUI

struct ExportView: View {

    @EnvironmentObject var store: ExperimentStore

    @State private var showShareSheet = false
    @State private var csvURL: URL? = nil
    @State private var exportError: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {

            // ── Session Summary ────────────────────────────────────────────
            if let s = store.session {
                VStack(alignment: .leading, spacing: 8) {
                    infoRow("Experiment ID", s.experimentId)
                    infoRow("Scenario",      s.scenario)
                    infoRow("Target",        s.target)
                    infoRow("Location",      s.location)
                    infoRow("Events",        "\(s.events.count)")
                    if !s.memo.isEmpty {
                        infoRow("Memo", s.memo)
                    }
                }
                .padding()
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.black, lineWidth: 1)
                )
            }

            // ── CSV Preview ────────────────────────────────────────────────
            Text("CSV Preview")
                .fontWeight(.bold)
                .foregroundColor(.black)

            ScrollView([.horizontal, .vertical]) {
                Text(store.generateCSV())
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.black)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 200)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.black, lineWidth: 1)
            )

            if let err = exportError {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.black)
            }

            // ── Export Button ──────────────────────────────────────────────
            Button(action: exportCSV) {
                Text("Export CSV")
                    .fontWeight(.bold)
                    .frame(maxWidth: .infinity)
                    .frame(height: 60)
                    .background(Color.black)
                    .foregroundColor(.white)
                    .cornerRadius(12)
            }

            // ── New Experiment ─────────────────────────────────────────────
            Button(action: store.newExperiment) {
                Text("New Experiment")
                    .fontWeight(.bold)
                    .frame(maxWidth: .infinity)
                    .frame(height: 60)
                    .foregroundColor(.black)
                    .background(Color.white)
                    .cornerRadius(12)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color.black, lineWidth: 1)
                    )
            }

            Spacer()
        }
        .padding()
        .background(Color.white)
        .navigationTitle("Export")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showShareSheet) {
            if let url = csvURL {
                ShareSheet(items: [url])
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .fontWeight(.bold)
                .foregroundColor(.black)
            Spacer()
            Text(value)
                .foregroundColor(.black)
                .multilineTextAlignment(.trailing)
        }
    }

    private func exportCSV() {
        exportError = nil
        let csv = store.generateCSV()
        let fileName = store.csvFileName()
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(fileName)
        do {
            try csv.write(to: tempURL, atomically: true, encoding: .utf8)
            csvURL = tempURL
            showShareSheet = true
        } catch {
            exportError = "Export failed: \(error.localizedDescription)"
        }
    }
}
