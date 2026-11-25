import 'dart:async';

import 'package:flutter/foundation.dart';

import '../mobile_log.dart';
import '../rust/flutter.dart';
import 'session_store.dart';

enum AccountPhase { starting, signedOut, signedIn, unavailable }

class AccountSession extends ChangeNotifier {
  AccountSession({required this.server, required this.deviceName, required this._store});

  final String server;
  final String deviceName;
  final SessionStore _store;

  final _client = FlutterClient.open();
  FlutterConnection? _connection;
  Future<void>? _observation;
  FlutterOperation? _operation;
  Future<void>? _work;
  Future<void> _transition = Future.value();
  Future<void>? _shutdown;
  Timer? _maintenance;
  String? _deviceId;
  Uint8List? _saved;
  Uint8List? _credentials;
  bool _removeOnRetry = false;
  bool _loaded = false;
  bool _active = false;
  bool _ready = false;
  bool _closed = false;
  bool _needsRevalidation = false;
  int? _lastConnectedGeneration;
  int? _lastRejection;

  AccountPhase phase = AccountPhase.starting;
  LinkStatus connection = LinkStatus.disconnected;
  String? email;
  String? error;
  bool get busy => _work != null;

  AccountContext _context({bool connect = true}) => AccountContext(
    server: server,
    authenticated: _saved,
    connect: connect && _active && _saved != null && !_removeOnRetry,
  );

  Future<void> setActive(bool active) {
    if (_closed) return _transition;
    if (_active == active && (!active || _ready)) return _transition;
    _active = active;
    if (!active) {
      _ready = false;
      _needsRevalidation = false;
      _maintenance?.cancel();
      _operation?.cancel();
      _connection?.stop();
    }

    _transition = _transition.then((_) async {
      if (_closed) return;
      try {
        if (active) {
          if (_active && !_ready) await _activate();
        } else {
          await _work;
          await _stopObservation();
          await _client.pause();
          _updateConnection(LinkStatus.disconnected);
        }
      } catch (exception) {
        MobileLog.error('Lifecycle transition failed category=${exception.runtimeType}');
        if (email == null) phase = AccountPhase.unavailable;
        _showError('暂时无法恢复登录，请重试');
      }
    });
    return _transition;
  }

  Future<void> _activate() async {
    if (!_loaded) {
      _deviceId = await _store.readDeviceId();
      if (_deviceId == null) {
        _deviceId = newDeviceId();
        await _store.writeDeviceId(_deviceId!);
      }
      final stored = await _store.readSession(server);
      if (stored != null) {
        try {
          email = sessionEmail(authenticated: stored, deviceId: _deviceId!);
          _saved = stored;
          _credentials = stored;
          MobileLog.info('Saved session loaded');
        } on Exception {
          await _store.deleteSession(server);
          MobileLog.warn('Invalid saved session removed');
        }
      }
      _loaded = true;
    }
    if (!_active || _closed) return;
    await _client.applySession(context: _context());
    if (!_active || _closed) return;
    _ready = true;
    _startObservation();
    phase = email == null ? AccountPhase.signedOut : AccountPhase.signedIn;
    error = null;
    _notify();
    if (_saved != null || _removeOnRetry) {
      unawaited(_account(SessionAction.restore));
    }
  }

  Future<bool> login(String email, String password) async {
    if (phase != AccountPhase.signedOut || !_active || !_ready || busy || _closed) {
      return false;
    }
    var signedIn = false;
    await _start(() async {
      if (_removeOnRetry) await _removeSession();
      final operation = _client.login(
        context: AccountContext(server: server, connect: false),
        email: email.trim(),
        password: password,
        deviceId: _deviceId!,
        deviceName: deviceName,
      );
      final reply = await _drive(operation);
      if (reply.result != AccountResult.success) {
        _showError(switch (reply.result) {
          AccountResult.invalidCredentials => '邮箱或密码错误',
          _ => '暂时无法登录，请重试',
        });
        return;
      }

      final credentials = reply.authenticated;
      if (credentials == null) throw StateError('Missing login session');
      final displayEmail = sessionEmail(authenticated: credentials, deviceId: _deviceId!);
      if (!_active || _closed) {
        await _revoke(credentials);
        return;
      }

      try {
        await _store.writeSession(server, credentials);
      } catch (_) {
        await _revoke(credentials);
        _showError('无法保存登录信息，请重试');
        return;
      }
      _saved = credentials;
      _credentials = credentials;
      this.email = displayEmail;
      phase = AccountPhase.signedIn;
      connection = _active ? LinkStatus.connecting : LinkStatus.disconnected;
      signedIn = true;
      MobileLog.info('Login session saved');
      await _client.applySession(context: _context());
      _schedule(reply.nextMaintenanceAtMs);
    });
    return signedIn;
  }

  Future<void> retry() => !_ready ? setActive(true) : _account(SessionAction.restore);

  Future<void> logout() => _account(SessionAction.logout);

  Future<void> _account(SessionAction action) {
    if (!_active || !_ready || _closed || busy || (_saved == null && !_removeOnRetry)) {
      return Future.value();
    }
    return _start(() async {
      if (_removeOnRetry) {
        await _removeSession();
        return;
      }
      await _saveCheckpoint();
      if (!_active || _closed) return;
      final reply = await _drive(
        _client.account(context: _context(), action: action),
        keepSession: true,
      );

      if (reply.result == AccountResult.unauthenticated ||
          (action == SessionAction.logout && reply.result == AccountResult.success)) {
        _removeOnRetry = true;
        await _client.applySession(context: _context(connect: false));
        await _removeSession();
        if (reply.result == AccountResult.unauthenticated) {
          _showError('登录已过期，请重新登录');
        }
      } else if (reply.result == AccountResult.success) {
        await _client.applySession(context: _context());
        _schedule(reply.nextMaintenanceAtMs);
      } else if (_active) {
        _showError(action == SessionAction.logout ? '暂时无法退出，请重试' : '暂时无法连接，请重试');
        _schedule(DateTime.now().millisecondsSinceEpoch + 30000);
      }
    });
  }

  Future<AccountReply> _drive(FlutterOperation operation, {bool keepSession = false}) async {
    _operation = operation;
    try {
      var reply = await operation.run();
      while (true) {
        if (keepSession) await _accept(reply.authenticated);
        if (!_active || reply.result != AccountResult.success || !reply.checkpoint) {
          return reply;
        }
        reply = await operation.resume(credentialVersion: reply.credentialVersion);
      }
    } finally {
      try {
        operation.cancel();
        if (keepSession) {
          final settled = await operation.settle();
          await _accept(settled.authenticated);
        }
      } finally {
        try {
          await operation.shutdown();
        } finally {
          operation.dispose();
          _operation = null;
        }
      }
    }
  }

  Future<void> _accept(Uint8List? updated) async {
    if (updated == null || listEquals(updated, _credentials)) return;
    final displayEmail = sessionEmail(authenticated: updated, deviceId: _deviceId!);
    _credentials = updated;
    await _saveCheckpoint();
    email = displayEmail;
  }

  Future<void> _saveCheckpoint() async {
    final credentials = _credentials;
    if (credentials == null || listEquals(credentials, _saved)) return;
    try {
      await _store.writeSession(server, credentials);
    } catch (_) {
      _showError('无法保存登录信息，请重试');
      rethrow;
    }
    _saved = credentials;
    MobileLog.info('Credential checkpoint saved');
    if (_active) await _client.applySession(context: _context());
  }

  Future<void> _removeSession() async {
    try {
      await _store.deleteSession(server);
    } catch (_) {
      _showError('无法清除登录信息，请重试');
      rethrow;
    }
    _saved = null;
    _credentials = null;
    _removeOnRetry = false;
    _needsRevalidation = false;
    email = null;
    phase = AccountPhase.signedOut;
    _updateConnection(LinkStatus.disconnected);
    await _client.applySession(context: _context());
    MobileLog.info('Local session removed');
  }

  Future<void> _revoke(Uint8List credentials) async {
    try {
      final operation = _client.account(
        context: AccountContext(server: server, authenticated: credentials, connect: false),
        action: SessionAction.revoke,
      );
      final outcome = await _drive(operation);
      MobileLog.info('Uncommitted login revocation result=${outcome.result.name}');
    } catch (exception) {
      MobileLog.warn('Uncommitted login revocation failed category=${exception.runtimeType}');
    }
  }

  Future<void> _start(Future<void> Function() action) {
    _maintenance?.cancel();
    error = null;
    _work = Future<void>(() async {
      try {
        if (!_active || _closed) return;
        await action();
      } catch (exception) {
        MobileLog.error('Account operation failed category=${exception.runtimeType}');
        if (_active && error == null) _showError('操作未完成，请重试');
        if (_removeOnRetry || !listEquals(_saved, _credentials)) {
          try {
            await _client.applySession(context: _context(connect: false));
          } catch (exception) {
            MobileLog.error('Connection stop failed category=${exception.runtimeType}');
          }
        }
      } finally {
        _work = null;
        _notify();
        if (_needsRevalidation && _active && !_closed) {
          _needsRevalidation = false;
          unawaited(_account(SessionAction.forceRestore));
        }
      }
    });
    _notify();
    return _work!;
  }

  void _startObservation() {
    if (_connection != null) return;
    final subscription = _client.observeConnection();
    _connection = subscription;
    _observation = _observe(subscription);
  }

  Future<void> _observe(FlutterConnection subscription) async {
    try {
      while (_active && !_closed) {
        final next = await subscription.next();
        if (next == null || !_active || _closed) break;
        final becameConnected =
            next.status == LinkStatus.connected &&
            (connection != LinkStatus.connected || _lastConnectedGeneration != next.generation);
        _updateConnection(next.status);
        if (next.rejected && _lastRejection != next.generation && _saved != null) {
          _lastRejection = next.generation;
          if (busy) {
            _needsRevalidation = true;
          } else {
            unawaited(_account(SessionAction.forceRestore));
          }
        } else if (becameConnected) {
          if (_lastConnectedGeneration != null && !busy) {
            unawaited(_account(SessionAction.restore));
          }
          _lastConnectedGeneration = next.generation;
        }
      }
    } catch (exception) {
      MobileLog.error('Connection observation failed category=${exception.runtimeType}');
      _updateConnection(LinkStatus.disconnected);
    }
  }

  Future<void> _stopObservation() async {
    _connection?.stop();
    await _observation;
    _connection?.dispose();
    _connection = null;
    _observation = null;
    _lastConnectedGeneration = null;
  }

  void _schedule(int timestamp) {
    if (!_active || _closed) return;
    _maintenance?.cancel();
    final delay = (timestamp - DateTime.now().millisecondsSinceEpoch).clamp(1000, 86400000);
    _maintenance = Timer(Duration(milliseconds: delay), () {
      unawaited(_account(SessionAction.maintain));
    });
  }

  void _updateConnection(LinkStatus status) {
    if (status == connection) return;
    connection = status;
    MobileLog.info('Connection changed status=${status.name}');
    _notify();
  }

  void _showError(String message) {
    if (!_active || _closed) return;
    error = message;
    _notify();
  }

  void _notify() {
    if (!_closed) notifyListeners();
  }

  Future<void> close() => _shutdown ??= _close();

  Future<void> _close() async {
    _closed = true;
    _active = false;
    _maintenance?.cancel();
    _operation?.cancel();
    _connection?.stop();
    await _transition;
    await _work;
    await _stopObservation();
    try {
      await _client.shutdown();
    } finally {
      _client.dispose();
      super.dispose();
    }
  }
}
