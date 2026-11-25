import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import 'src/account/account_session.dart';
import 'src/account/session_store.dart';
import 'src/account/sign_in_page.dart';
import 'src/rust/flutter.dart';

const _server = 'https://xiaowei.tctony.com';

AccountSession _createSession() => AccountSession(
  server: _server,
  deviceName: defaultTargetPlatform == TargetPlatform.iOS ? 'iPhone' : 'Android',
  store: const SecureSessionStore(),
);

class XiaoWeiApp extends StatefulWidget {
  const XiaoWeiApp({super.key, this.createSession = _createSession});

  final AccountSession Function() createSession;

  @override
  State<XiaoWeiApp> createState() => _XiaoWeiAppState();
}

class _XiaoWeiAppState extends State<XiaoWeiApp> {
  late final AccountSession _account;
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _account = widget.createSession();
    _lifecycle = AppLifecycleListener(
      onPause: () => unawaited(_account.setActive(false)),
      onResume: () => unawaited(_account.setActive(true)),
      onDetach: () => unawaited(_account.setActive(false)),
    );
    unawaited(_account.setActive(true));
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    unawaited(_account.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '小微',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xff225b51)),
      darkTheme: ThemeData(colorSchemeSeed: const Color(0xff225b51), brightness: Brightness.dark),
      home: ListenableBuilder(
        listenable: _account,
        builder: (context, _) => switch (_account.phase) {
          AccountPhase.starting => const Scaffold(body: Center(child: CircularProgressIndicator())),
          AccountPhase.signedOut => SignInPage(account: _account),
          AccountPhase.signedIn => _SignedInPage(account: _account),
          AccountPhase.unavailable => Scaffold(
            body: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('无法读取登录信息'),
                  TextButton(onPressed: _account.retry, child: const Text('重试')),
                ],
              ),
            ),
          ),
        },
      ),
    );
  }
}

class _SignedInPage extends StatelessWidget {
  const _SignedInPage({required this.account});

  final AccountSession account;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (icon, status) = switch (account.connection) {
      LinkStatus.connected => (Icons.cloud_done_outlined, '已连接'),
      LinkStatus.connecting => (Icons.cloud_queue_outlined, '正在连接'),
      LinkStatus.reconnecting => (Icons.sync, '正在重新连接'),
      LinkStatus.disconnected => (Icons.cloud_off_outlined, '未连接'),
    };

    return Scaffold(
      appBar: AppBar(title: const Text('小微')),
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.all(24),
              children: [
                Card(
                  child: Column(
                    children: [
                      ListTile(
                        leading: const Icon(Icons.account_circle_outlined),
                        title: const Text('账号'),
                        subtitle: Text(account.email ?? ''),
                      ),
                      const Divider(height: 1, indent: 16, endIndent: 16),
                      Semantics(
                        liveRegion: true,
                        child: ListTile(
                          key: const Key('account.connection'),
                          leading: Icon(icon, color: colors.primary),
                          title: Text(status),
                          subtitle: Text(Uri.parse(account.server).host),
                        ),
                      ),
                    ],
                  ),
                ),
                if (account.error case final error?)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(error, style: TextStyle(color: colors.error)),
                    ),
                  ),
                if (account.connection != LinkStatus.connected)
                  OutlinedButton(
                    onPressed: account.busy ? null : account.retry,
                    child: const Text('重试连接'),
                  ),
                TextButton(
                  onPressed: account.busy ? null : account.logout,
                  child: const Text('退出登录'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class MobileStartupError extends StatelessWidget {
  const MobileStartupError({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Scaffold(body: Center(child: Text('小微无法启动，请重开 App'))),
    );
  }
}
