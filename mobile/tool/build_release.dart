import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/dart/element/element.dart';

const _buildTargets = {'ios', 'apk'};
final _logLibrary = Uri.parse('package:mobile/src/mobile_log.dart');

Future<void> main(List<String> args) async {
  if (args.isEmpty || !_buildTargets.contains(args.first)) {
    stderr.writeln('Usage: fvm dart run tool/build_release.dart <ios|apk> [Flutter options]');
    exitCode = 64;
    return;
  }

  final mobile = Directory.fromUri(Platform.script.resolve('../'));
  final toolDirectory = Directory.fromUri(mobile.uri.resolve('.dart_tool/'));
  final overlay = await toolDirectory.createTemp('release-log-');
  try {
    final count = await prepareLogSources(mobile, overlay);
    stdout.writeln('Added source locations to $count Flutter log calls.');
    final config = File.fromUri(overlay.uri.resolve('package_config.json'));
    final build = await Process.start(
      'fvm',
      [
        'flutter',
        '--suppress-analytics',
        'build',
        args.first,
        ...args.skip(1),
        '--release',
        '--no-pub',
        '--extra-front-end-options=--packages=${config.path}',
      ],
      workingDirectory: mobile.path,
      mode: ProcessStartMode.inheritStdio,
    );
    exitCode = await build.exitCode;
  } finally {
    await overlay.delete(recursive: true);
  }
}

Future<int> prepareLogSources(Directory project, Directory overlay) async {
  final mobile = Directory(project.resolveSymbolicLinksSync());
  final lib = Directory.fromUri(mobile.uri.resolve('lib/'));
  final packageConfig = File.fromUri(mobile.uri.resolve('.dart_tool/package_config.json'));
  final config = jsonDecode(await packageConfig.readAsString()) as Map<String, dynamic>;
  final packages = (config['packages'] as List).cast<Map<String, dynamic>>();
  final flutter = Directory.fromUri(packageConfig.uri.resolve(config['flutterRoot'] as String));
  final sdk = Directory.fromUri(flutter.uri.resolve('bin/cache/dart-sdk/'));

  // Keep Flutter's dependency resolution and redirect its app package to the instrumented sources.
  for (final package in packages) {
    package['rootUri'] = package['name'] == 'mobile'
        ? overlay.uri.toString()
        : packageConfig.uri.resolve(package['rootUri'] as String).toString();
  }
  await File.fromUri(overlay.uri.resolve('package_config.json')).writeAsString(jsonEncode(config));

  final contexts = AnalysisContextCollection(
    includedPaths: [lib.resolveSymbolicLinksSync()],
    sdkPath: sdk.resolveSymbolicLinksSync(),
  );
  var count = 0;
  try {
    await for (final file in lib.list(recursive: true)) {
      if (file is! File) continue;
      final relative = file.uri.pathSegments.skip(mobile.uri.pathSegments.length - 1).join('/');
      final output = File.fromUri(overlay.uri.resolveUri(Uri(path: relative)));
      await output.parent.create(recursive: true);

      if (!file.path.endsWith('.dart')) {
        await file.copy(output.path);
        continue;
      }

      final session = contexts.contextFor(file.path).currentSession;
      final result = await session.getResolvedUnit(file.path);
      if (result is! ResolvedUnitResult) {
        throw StateError('Cannot resolve $relative for log source injection');
      }

      final calls = _LogCalls();
      result.unit.accept(calls);

      var content = result.content;
      for (final call in calls.invocations.reversed) {
        final line = result.lineInfo.getLocation(call.offset).lineNumber;
        final source = jsonEncode('mobile/$relative:$line').replaceAll(r'$', r'\$');
        final insertion = call.argumentList.arguments.last.end;
        content = content.replaceRange(insertion, insertion, ', source: $source');
      }
      count += calls.invocations.length;
      await output.writeAsString(content);
    }
  } finally {
    await contexts.dispose();
  }
  return count;
}

class _LogCalls extends RecursiveAstVisitor<void> {
  final invocations = <MethodInvocation>[];

  @override
  void visitMethodInvocation(MethodInvocation node) {
    super.visitMethodInvocation(node);
    final method = node.methodName.element;
    if (method is! MethodElement ||
        !method.isStatic ||
        method.enclosingElement?.name != 'MobileLog' ||
        method.library.uri != _logLibrary ||
        !const {'info', 'warn', 'error'}.contains(method.name)) {
      return;
    }

    final arguments = node.argumentList.arguments;
    if (arguments.isEmpty ||
        arguments.any((arg) => arg is NamedArgument && arg.name.lexeme == 'source')) {
      return;
    }
    invocations.add(node);
  }
}
