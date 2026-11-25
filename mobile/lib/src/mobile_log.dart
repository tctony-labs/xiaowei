import 'package:flutter/foundation.dart';

class MobileLog {
  static void info(String message, {String source = 'mobile'}) => _write('info', source, message);
  static void warn(String message, {String source = 'mobile'}) => _write('warn', source, message);
  static void error(String message, {String source = 'mobile'}) => _write('error', source, message);

  static void _write(String level, String source, String message) {
    final timestamp = DateTime.now().toIso8601String().substring(0, 23).replaceFirst('T', ' ');
    debugPrint('$timestamp [${level.padLeft(5)}] [$source] $message');
  }
}
