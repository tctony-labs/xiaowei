import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/build_release.dart';

void main() {
  test('adds the original call site only to direct MobileLog calls', () async {
    final sandbox = await Directory.systemTemp.createTemp('mobile-log-test-');
    addTearDown(() => sandbox.delete(recursive: true));
    final mobile = Directory.fromUri(sandbox.uri.resolve('project/'));
    final overlay = Directory.fromUri(sandbox.uri.resolve('overlay/'));
    await overlay.create();

    final config = jsonDecode(await File('.dart_tool/package_config.json').readAsString());
    await _write(mobile, 'pubspec.yaml', 'name: mobile\nenvironment:\n  sdk: ^3.14.0\n');
    await _write(
      mobile,
      '.dart_tool/package_config.json',
      jsonEncode({
        'configVersion': 2,
        'flutterRoot': config['flutterRoot'],
        'packages': [
          {'name': 'mobile', 'rootUri': '../', 'packageUri': 'lib/', 'languageVersion': '3.14'},
        ],
      }),
    );
    await _write(mobile, 'lib/src/mobile_log.dart', '''
class MobileLog {
  static void info(String message, {String source = 'mobile'}) {}
  static void warn(String message, {String source = 'mobile'}) {}
  static void error(String message, {String source = 'mobile'}) {}
}
''');

    const source = '''
import 'src/mobile_log.dart' as logs;

class MobileLog {
  static void info(String message) {}
}

void main() {
  logs.MobileLog.info('started');
  logs.MobileLog.warn(
    'temporary failure',
  );
  logs.MobileLog.error('custom source', source: 'explicit');
  MobileLog.info('other class');
  // logs.MobileLog.info('comment');
  final text = "logs.MobileLog.info('text')";
  print(text);
}
''';
    await _write(mobile, 'lib/main.dart', source);

    expect(await prepareLogSources(mobile, overlay), 2);
    final generated = await File.fromUri(overlay.uri.resolve('lib/main.dart')).readAsString();
    expect(
      generated,
      source
          .replaceFirst("'started'", '\'started\', source: "mobile/lib/main.dart:8"')
          .replaceFirst(
            "'temporary failure'",
            '\'temporary failure\', source: "mobile/lib/main.dart:9"',
          ),
    );
    expect(await File.fromUri(mobile.uri.resolve('lib/main.dart')).readAsString(), source);
  });
}

Future<void> _write(Directory root, String path, String contents) async {
  final file = File.fromUri(root.uri.resolve(path));
  await file.parent.create(recursive: true);
  await file.writeAsString(contents);
}
