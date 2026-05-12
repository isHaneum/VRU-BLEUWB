import Foundation
import CoreBluetooth
import Combine

final class BLEAdvertiser: NSObject, ObservableObject, CBPeripheralManagerDelegate {

    @Published private(set) var statusText = "Idle"
    @Published private(set) var advertisedName = ""

    private let serviceUUID = CBUUID(string: "7C6E1001-5C58-43C5-A6E2-FA2C6E0A1001")
    private var peripheralManager: CBPeripheralManager?
    private var pendingPayload: [String: Any]?

    override init() {
        super.init()
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    }

    func startAdvertising(experimentId: String, nodeId: String, eventCode: String) {
        let name = makeAdvertisedName(experimentId: experimentId, nodeId: nodeId, eventCode: eventCode)
        let payload: [String: Any] = [
            CBAdvertisementDataLocalNameKey: name,
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID]
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

    private func applyAdvertisingIfPossible() {
        guard let peripheralManager, peripheralManager.state == .poweredOn, let pendingPayload else {
            return
        }

        peripheralManager.stopAdvertising()
        peripheralManager.startAdvertising(pendingPayload)
        statusText = "Advertising"
    }

    private func makeAdvertisedName(experimentId: String, nodeId: String, eventCode: String) -> String {
        let exp = sanitize(experimentId, fallback: "EXP")
        let node = sanitize(nodeId, fallback: "NODE")
        let event = sanitize(eventCode, fallback: "START")
        let raw = "VRU_\(node)_\(event)_\(exp)"
        return String(raw.prefix(26))
    }

    private func sanitize(_ input: String, fallback: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return fallback
        }

        let filtered = trimmed.uppercased().filter { $0.isLetter || $0.isNumber || $0 == "_" }
        return filtered.isEmpty ? fallback : filtered
    }
}