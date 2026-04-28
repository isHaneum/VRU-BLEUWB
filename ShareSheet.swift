import SwiftUI
import UIKit

struct ShareSheet: UIViewControllerRepresentable {

    var items: [Any]

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}

    class Coordinator: NSObject {}
}
