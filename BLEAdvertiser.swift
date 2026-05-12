import Foundation
import CoreBluetooth
import Combine

final class BLEAdvertiser: NSObject, ObservableObject, CBPeripheralManagerDelegate {

    @Published private(set) var statusText = "Idle"
    @Published private(set) var advertisedName = ""

    private var peripheralManager: CBPeripheralManager?
    private var pendingPayload: [String: Any]?

    override init() {
        super.init()
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    }

    func startAdvertising(experimentId: String, nodeId: String, eventCode: String) {
        let name = makeAdvertisedName(experimentId: experimentId, nodeId: nodeId, eventCode: eventCode)
        let payload: [String: Any] = [
            CBAdvertisementDataLocalNameKey: name
        ]

        advertisedName = name
        pendingPayload = payload
        applyAdvertisingIfPossible()
    }

    func stopAdvertising() {
        peripheralManager?.stopAdvertising()
        pendingPayload = nil
        advertisedName = ""
        statusText = "Stopped"
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            statusText = "Powered On"
            applyAdvertisingIfPossible()
        case .poweredOff:
            statusText = "Bluetooth Off"
        case .unauthorized:
            statusText = "Bluetooth Unauthorized"
        case .unsupported:
            statusText = "Bluetooth Unsupported"
        case .resetting:
            statusText = "Bluetooth Resetting"
        case .unknown:
            statusText = "Bluetooth Unknown"
        @unknown default:
            statusText = "Bluetooth Unknown"
        }
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: (any Error)?) {
        if let error {
            statusText = "Advertising Error: \(error.localizedDescription)"
            return
        }

        statusText = "Advertising"
    }

    private func applyAdvertisingIfPossible() {
        guard let peripheralManager, peripheralManager.state == .poweredOn, let pendingPayload else {
            return
        }

        peripheralManager.stopAdvertising()
        peripheralManager.startAdvertising(pendingPayload)
        statusText = "Starting"
    }

    private func makeAdvertisedName(experimentId: String, nodeId: String, eventCode: String) -> String {
        let node = shortNodeId(from: nodeId)
        let event = shortEventCode(from: eventCode)
        return "VRU_\(node)_\(event)"
    }

    private func sanitize(_ input: String, fallback: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return fallback
        }

        let filtered = trimmed.uppercased().filter { $0.isLetter || $0.isNumber || $0 == "_" }
        return filtered.isEmpty ? fallback : filtered
    }

    private func shortNodeId(from nodeId: String) -> String {
        let cleaned = sanitize(nodeId, fallback: "A")
        if cleaned.hasPrefix("NODE_") {
          return String(cleaned.dropFirst(5).prefix(2))
        }
        return String(cleaned.prefix(2))
    }

    private func shortEventCode(from eventCode: String) -> String {
        switch sanitize(eventCode, fallback: "ST") {
        case "VISIBLE": return "VIS"
        case "WALL_CORNER": return "WAL"
        case "HUMAN_OCCLUDED": return "HUM"
        case "CAR_OCCLUDED": return "VEH"
        case "START": return "STA"
        case "END": return "END"
        case "PAUSE": return "PAU"
        case "RESUME": return "RES"
        default:
            return String(sanitize(eventCode, fallback: "EVT").prefix(3))
        }
    }
}