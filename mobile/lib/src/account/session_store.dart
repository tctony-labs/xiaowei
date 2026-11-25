import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class SessionStore {
  Future<String?> readDeviceId();
  Future<void> writeDeviceId(String id);
  Future<Uint8List?> readSession(String server);
  Future<void> writeSession(String server, Uint8List session);
  Future<void> deleteSession(String server);
}

class SecureSessionStore implements SessionStore {
  const SecureSessionStore();

  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accountName: 'com.tctony.xiaowei.mobile.session',
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
    aOptions: AndroidOptions(resetOnError: false),
  );

  @override
  Future<String?> readDeviceId() => _storage.read(key: 'device-id');

  @override
  Future<void> writeDeviceId(String id) => _storage.write(key: 'device-id', value: id);

  @override
  Future<Uint8List?> readSession(String server) async {
    final value = await _storage.read(key: 'session:$server');
    return value == null ? null : base64Decode(value);
  }

  @override
  Future<void> writeSession(String server, Uint8List session) =>
      _storage.write(key: 'session:$server', value: base64Encode(session));

  @override
  Future<void> deleteSession(String server) => _storage.delete(key: 'session:$server');
}
