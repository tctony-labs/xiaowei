import SwiftUI

struct AccountSection: View {
    let account: AccountSession
    let retry: () -> Void
    let login: () -> Void

    var body: some View {
        Section("账号") {
            LabeledContent("服务器", value: account.server)
            LabeledContent("登录状态", value: account.statusLabel)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("登录状态")
                .accessibilityValue(account.statusLabel)
                .accessibilityIdentifier("account.status")

            if account.isAuthenticated {
                LabeledContent("ID", value: account.userID)
                    .accessibilityIdentifier("account.user")
                LabeledContent("邮箱", value: account.email)
            }
            if let error = account.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("account.error")
            }
            if account.isWorking {
                Button("取消") { account.cancelOperation() }
                    .accessibilityIdentifier("account.cancel")
            } else if account.isAuthenticated {
                Button("重试", action: retry)
                    .accessibilityIdentifier("account.retry")
                Button("退出登录", role: .destructive) { account.logout() }
                    .accessibilityIdentifier("account.logout")
            } else {
                Button("登录", action: login)
                    .accessibilityIdentifier("account.login")
                if account.errorMessage != nil {
                    Button("重试", action: retry)
                        .accessibilityIdentifier("account.retry")
                }
            }
        }
    }
}
