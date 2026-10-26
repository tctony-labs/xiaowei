import SwiftUI

struct LoginView: View {
    let account: AccountSession
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(account.server)
                        .foregroundStyle(.secondary)
                    TextField("邮箱", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login.email")
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                        .accessibilityIdentifier("login.password")
                }
                .disabled(account.isWorking)

                if let error = account.errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("login.error")
                }
                Button(account.isWorking ? "正在登录…" : "登录") {
                    account.login(email: email, password: password)
                    password = ""
                }
                .disabled(account.isWorking || email.isEmpty || password.isEmpty)
                .accessibilityIdentifier("login.submit")
            }
            .navigationTitle("登录")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        account.cancelOperation()
                        password = ""
                        dismiss()
                    }
                    .accessibilityIdentifier("login.cancel")
                }
            }
            .onChange(of: account.isAuthenticated) { _, authenticated in
                if authenticated {
                    password = ""
                    dismiss()
                }
            }
            .onDisappear {
                password = ""
                if account.status == .signingIn { account.cancelOperation() }
            }
        }
    }
}
