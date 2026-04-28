import SwiftUI

@main
struct ExperimentLoggerApp: App {

    @StateObject private var store = ExperimentStore()

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $store.navigationPath) {
                SetupView()
                    .navigationDestination(for: AppRoute.self) { route in
                        switch route {
                        case .recording:
                            RecordingView()
                        case .export:
                            ExportView()
                        }
                    }
            }
            .environmentObject(store)
            // Force light mode so black-on-white design is consistent
            .preferredColorScheme(.light)
        }
    }
}
