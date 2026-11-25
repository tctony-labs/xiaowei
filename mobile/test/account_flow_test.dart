import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/app.dart';
import 'package:mobile/src/account/account_session.dart';
import 'package:mobile/src/account/session_store.dart';
import 'package:mobile/src/rust/flutter.dart';
import 'package:mobile/src/rust/frb_generated.dart';

void main() {
  final library = Platform.environment['XIAOWEI_FLUTTER_TEST_LIBRARY'];
  final server = Platform.environment['XIAOWEI_FLUTTER_TEST_SERVER'];
  final control = Platform.environment['XIAOWEI_FLUTTER_TEST_CONTROL'];

  testWidgets(
    'login, authenticated WebSocket, foreground reconnection, recovery and logout',
    skip: library == null,
    (tester) async {
      await tester.runAsync(() => RustLib.init(externalLibrary: ExternalLibrary.open(library!)));
      addTearDown(RustLib.dispose);

      final store = _MemoryStore();
      AccountSession getSession() =>
          AccountSession(server: server!, deviceName: 'fixture-device', store: store);

      final first = getSession();
      addTearDown(first.close);
      await tester.runAsync(() => first.setActive(true));
      expect(first.phase, AccountPhase.signedOut);
      await tester.pumpWidget(XiaoWeiApp(createSession: () => first));
      await tester.pumpAndSettle();
      expect(find.text('登录小微'), findsOneWidget);
      final submit = find.byKey(const Key('login.submit'));
      final email = find.byKey(const Key('login.email'));
      final password = find.byKey(const Key('login.password'));

      await tester.tap(submit);
      await tester.pumpAndSettle();
      expect(find.text('请输入邮箱地址'), findsOneWidget);
      expect(find.text('请输入密码'), findsOneWidget);

      await tester.enterText(email, 'before@example.test');
      await tester.enterText(password, 'wrong password');
      await tester.runAsync(() async {
        await tester.tap(submit);
        await _waitUntil(() => !first.busy);
      });
      await tester.pumpAndSettle();
      expect(find.text('邮箱或密码错误'), findsOneWidget);
      expect(store.session, isNull);

      await tester.enterText(password, ' synthetic fixture password ');
      await tester.runAsync(() async {
        await tester.tap(submit);
        await _waitUntil(() => first.connection == LinkStatus.connected && !first.busy);
      });
      await tester.pumpAndSettle();
      expect(first.phase, AccountPhase.signedIn);
      expect(find.text('before@example.test'), findsOneWidget);
      expect(find.text('已连接'), findsOneWidget);
      expect(store.session, isNotNull);

      final statuses = <LinkStatus>[];
      first.addListener(() => statuses.add(first.connection));
      await tester.runAsync(() async {
        final result = await Process.run('curl', ['-fsS', '$control/disconnect']);
        expect(result.exitCode, 0);
        await _waitUntil(
          () =>
              statuses.contains(LinkStatus.reconnecting) &&
              first.connection == LinkStatus.connected &&
              !first.busy,
        );
      });
      await tester.pumpAndSettle();
      expect(find.text('已连接'), findsOneWidget);

      await tester.runAsync(() async {
        await first.setActive(false);
        expect(first.connection, LinkStatus.disconnected);
        await first.setActive(true);
        await _waitUntil(() => first.connection == LinkStatus.connected && !first.busy);
        await first.close();
      });
      await tester.pumpWidget(const SizedBox());

      final reopened = getSession();
      addTearDown(reopened.close);
      await tester.runAsync(() async {
        await reopened.setActive(true);
        expect(reopened.phase, AccountPhase.signedIn);
        await _waitUntil(() => reopened.connection == LinkStatus.connected && !reopened.busy);
        await reopened.logout();
        expect(reopened.phase, AccountPhase.signedOut);
        expect(store.session, isNull);
        await reopened.close();
      });
      await tester.pumpAndSettle();
    },
  );
}

Future<void> _waitUntil(bool Function() check) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (!check()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('Account operation did not become ready');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

class _MemoryStore implements SessionStore {
  Uint8List? session;

  @override
  Future<String?> readDeviceId() async => '00000000-0000-4000-8000-000000000001';

  @override
  Future<void> writeDeviceId(String id) async {}

  @override
  Future<Uint8List?> readSession(String server) async => session;

  @override
  Future<void> writeSession(String server, Uint8List value) async => session = value;

  @override
  Future<void> deleteSession(String server) async => session = null;
}
