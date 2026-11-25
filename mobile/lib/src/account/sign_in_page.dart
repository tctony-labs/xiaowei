import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import 'account_session.dart';

class SignInPage extends StatefulWidget {
  const SignInPage({super.key, required this.account});

  final AccountSession account;

  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;

  Future<void> _submit() async {
    if (widget.account.busy || !_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    final signedIn = await widget.account.login(_email.text, _password.text);
    if (signedIn) TextInput.finishAutofillContext();
    if (mounted) _password.clear();
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final busy = widget.account.busy;

    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, viewport) => SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: viewport.maxHeight),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 400),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 32),
                    child: AutofillGroup(
                      onDisposeAction: AutofillContextAction.cancel,
                      child: Form(
                        key: _form,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Align(
                              alignment: Alignment.centerLeft,
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: colors.primaryContainer,
                                  borderRadius: BorderRadius.circular(16),
                                ),
                                child: Padding(
                                  padding: const EdgeInsets.all(14),
                                  child: Icon(Icons.bubble_chart_outlined, color: colors.primary),
                                ),
                              ),
                            ),
                            const SizedBox(height: 18),
                            Text('登录小微', style: theme.textTheme.headlineMedium),
                            const SizedBox(height: 28),
                            TextFormField(
                              key: const Key('login.email'),
                              controller: _email,
                              enabled: !busy,
                              autofillHints: const [AutofillHints.username],
                              keyboardType: TextInputType.emailAddress,
                              textInputAction: TextInputAction.next,
                              autocorrect: false,
                              decoration: const InputDecoration(
                                labelText: '邮箱',
                                border: OutlineInputBorder(),
                              ),
                              validator: (value) =>
                                  (value ?? '').trim().contains('@') ? null : '请输入邮箱地址',
                            ),
                            const SizedBox(height: 16),
                            TextFormField(
                              key: const Key('login.password'),
                              controller: _password,
                              enabled: !busy,
                              autofillHints: const [AutofillHints.password],
                              obscureText: _obscure,
                              enableSuggestions: false,
                              autocorrect: false,
                              textInputAction: TextInputAction.done,
                              decoration: InputDecoration(
                                labelText: '密码',
                                border: const OutlineInputBorder(),
                                suffixIcon: IconButton(
                                  onPressed: busy
                                      ? null
                                      : () => setState(() => _obscure = !_obscure),
                                  tooltip: _obscure ? '显示密码' : '隐藏密码',
                                  icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off),
                                ),
                              ),
                              validator: (value) => (value ?? '').isEmpty ? '请输入密码' : null,
                              onFieldSubmitted: (_) => _submit(),
                            ),
                            if (widget.account.error case final error?)
                              Padding(
                                padding: const EdgeInsets.only(top: 12),
                                child: Semantics(
                                  liveRegion: true,
                                  child: Text(error, style: TextStyle(color: colors.error)),
                                ),
                              ),
                            const SizedBox(height: 20),
                            FilledButton(
                              key: const Key('login.submit'),
                              onPressed: busy ? null : _submit,
                              child: Text(busy ? '正在登录…' : '登录'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
