import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart';

import 'app.dart';
import 'src/mobile_log.dart';
import 'src/rust/frb_generated.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    // Xcode links the Rust library into Runner, so iOS resolves its process symbols.
    final library = Platform.isIOS ? ExternalLibrary.process(iKnowHowToUseIt: true) : null;
    await RustLib.init(externalLibrary: library);
    runApp(const XiaoWeiApp());
  } catch (error) {
    MobileLog.error('App startup failed category=${error.runtimeType}');
    runApp(const MobileStartupError());
  }
}
