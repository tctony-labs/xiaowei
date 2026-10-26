import SwiftUI

struct ConnectionView: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("服务", value: model.healthStatus)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("服务")
                        .accessibilityValue(model.healthStatus)
                        .accessibilityIdentifier("service.status")
                    LabeledContent("连接", value: model.connectionStatus)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("连接")
                        .accessibilityValue(model.connectionStatus)
                        .accessibilityIdentifier("connection.status")
                    LabeledContent("状态", value: model.phaseLabel)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("状态")
                        .accessibilityValue(model.phaseLabel)
                        .accessibilityIdentifier("lifecycle.status")
                }
                Section {
                    Button("检查连接") {
                        if model.phase != .ready { model.enterForeground() }
                        Task { await model.checkConnection() }
                    }
                    .disabled(
                        model.phase == .starting || model.phase == .pausing
                            || model.phase == .closing || model.isChecking
                    )
                    .accessibilityIdentifier("connection.check")

                    Button("停止连接", role: .destructive) {
                        Task { await model.shutdown() }
                    }
                    .disabled(model.phase == .closing || model.phase == .closed)
                    .accessibilityIdentifier("connection.stop")
                }
            }
            .navigationTitle("小微")
        }
    }
}
