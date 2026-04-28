import SwiftUI
import UIKit

struct RecordingView: View {

    @EnvironmentObject var store: ExperimentStore

    @State private var elapsedTime: Double = 0
    @State private var timer: Timer? = nil
    @State private var showResetAlert = false

    private let twoColumns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(spacing: 0) {

            // ── Header ─────────────────────────────────────────────────────
            VStack(spacing: 6) {
                Text(store.session?.experimentId ?? "")
                    .font(.headline)
                    .foregroundColor(.black)
                Text(String(format: "%.1f s", elapsedTime))
                    .font(.system(size: 52, weight: .bold, design: .monospaced))
                    .foregroundColor(.black)
                Text(store.session?.scenario ?? "")
                    .font(.subheadline)
                    .foregroundColor(.black)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(Color.white)

            Divider()

            // ── Event Buttons (scrollable) ─────────────────────────────────
            ScrollView {
                LazyVGrid(columns: twoColumns, spacing: 12) {
                    eventButton("Car Occluded",   code: "CAR_OCCLUDED")
                    eventButton("Human Occluded", code: "HUMAN_OCCLUDED")
                    eventButton("Wall / Corner",  code: "WALL_CORNER")
                    eventButton("Move Start",     code: "MOVE_START")
                    eventButton("Visible",        code: "VISIBLE")
                    eventButton("Danger Point",   code: "DANGER_POINT")
                    eventButton("Pause",          code: "PAUSE")
                    eventButton("Resume",         code: "RESUME")
                }
                .padding(.horizontal)
                .padding(.top, 12)

                // End Experiment — dashed warning border
                Button(action: endExperiment) {
                    Text("End Experiment")
                        .fontWeight(.bold)
                        .frame(maxWidth: .infinity)
                        .frame(height: 60)
                        .foregroundColor(.black)
                        .background(Color.white)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(
                                    style: StrokeStyle(lineWidth: 2.5, dash: [8, 5])
                                )
                                .foregroundColor(.black)
                        )
                        .cornerRadius(10)
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
            }

            Divider()

            // ── Event Log ──────────────────────────────────────────────────
            eventLogSection
        }
        .background(Color.white)
        .navigationTitle("Recording")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Reset Events", isPresented: $showResetAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) { store.resetEvents() }
        } message: {
            Text("START 이후 모든 이벤트가 삭제됩니다.")
        }
        .onAppear { startTimer() }
        .onDisappear { stopTimer() }
    }

    // MARK: - Event Log Section

    private var eventLogSection: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Event Log")
                    .fontWeight(.bold)
                    .foregroundColor(.black)
                Spacer()
                Button("Undo") { store.undoLastEvent() }
                    .foregroundColor(.black)
                    .padding(.trailing, 16)
                Button("Reset") { showResetAlert = true }
                    .foregroundColor(.black)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            List(Array((store.session?.events ?? []).reversed())) { event in
                HStack(spacing: 10) {
                    Text(String(format: "%.3f", event.timeS))
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundColor(.black)
                        .frame(width: 60, alignment: .trailing)
                    Text(event.event)
                        .font(.footnote)
                        .fontWeight(.bold)
                        .foregroundColor(.black)
                    if !event.note.isEmpty {
                        Text(event.note)
                            .font(.footnote)
                            .foregroundColor(.black)
                    }
                }
                .listRowBackground(Color.white)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.white)
            .frame(height: 160)
        }
    }

    // MARK: - Event Button Builder

    @ViewBuilder
    private func eventButton(_ label: String, code: String) -> some View {
        Button(action: {
            store.addEvent(code: code)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }) {
            Text(label)
                .fontWeight(.bold)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 56)
                .background(Color.white)
                .foregroundColor(.black)
                .cornerRadius(10)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.black, lineWidth: 1)
                )
        }
    }

    // MARK: - Timer

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            guard let start = store.session?.startTime else { return }
            DispatchQueue.main.async {
                elapsedTime = Date().timeIntervalSince(start)
            }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: - End Experiment

    private func endExperiment() {
        store.addEvent(code: "END")
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        stopTimer()
    }
}
