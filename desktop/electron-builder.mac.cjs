const base = require("./electron-builder.json");
const { feedUrl, publicKey, sparkleDirectory } = require("../scripts/release/sparkle.mjs");
const { signingConfiguration } = require("../scripts/release/signing.mjs");
const signed = process.env.XIAOWEI_MAC_SIGNED === "1";
const signing = signed ? signingConfiguration() : undefined;

module.exports = {
  ...base,
  files: [
    ...base.files,
    "!**/*.map",
    "!**/node_modules/**/*.d.{ts,mts,cts}",

    // These SDKs export compiled JS; their original TypeScript is not loaded at runtime.
    "!**/node_modules/openai/src/**",
    "!**/node_modules/@anthropic-ai/sdk/src/**",

    // Node exports select dist/node; retain its ESM/CJS entries and tokenizer support.
    "!**/node_modules/@google/genai/dist/web/**",
    "!**/node_modules/@google/genai/dist/index.{mjs,cjs}",

    // Keep the package's Node main and fetch-blob's explicit ES2018 ponyfill import.
    "!**/node_modules/web-streams-polyfill/dist/*.{mjs,min.js}",
    "!**/node_modules/web-streams-polyfill/dist/{polyfill.es6.js,polyfill.es2018.js,ponyfill.js,ponyfill.es6.js}",

    // Node protobuf entrypoints load src; dist contains standalone browser bundles.
    "!**/node_modules/protobufjs/dist/**",

    // AWS/Smithy main and node exports select dist-cjs, including for ESM callers.
    "!**/node_modules/@aws-sdk/*/dist-es/**",
    "!**/node_modules/@smithy/*/dist-es/**",
    "!**/node_modules/@smithy/core/dist-cjs/**/*.{browser,native}.js",
    "!**/node_modules/@anthropic-ai/sdk/**/*.browser.{js,mjs}",

    // These browser-only entrypoints/tests are not selected by the Node worker.
    "!**/node_modules/gaxios/build/{cjs,esm}/browser-test/**",
    "!**/node_modules/ws/browser.js",
    "!**/node_modules/debug/src/browser.js",
    "!**/node_modules/bowser/bundled.js",
  ],
  buildVersion: require("./package.json").version,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these artifact macros.
  artifactName: "${productName}-${version}-${arch}.${ext}",
  forceCodeSigning: signed,
  extraResources: [
    ...base.extraResources,
    { from: `${sparkleDirectory}/LICENSE`, to: "Sparkle-LICENSE" },
  ],
  extraFiles: [
    { from: `${sparkleDirectory}/Sparkle.framework`, to: "Frameworks/Sparkle.framework" },
  ],
  dmg: { writeUpdateInfo: false, sign: signed },
  mac: {
    ...base.mac,
    electronLanguages: ["zh_CN", "en"],
    type: "distribution",
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    identity: signed ? signing.identity : "-",
    hardenedRuntime: signed,
    // Submit only the final DMG; its notarization also covers the signed app inside.
    notarize: false,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    extendInfo: {
      SUFeedURL: feedUrl,
      SUPublicEDKey: publicKey(process.env.SPARKLE_ED_PUBLIC_KEY),
      SURequireSignedFeed: true,
      SUVerifyUpdateBeforeExtraction: true,
      SUEnableAutomaticChecks: true,
      SUScheduledCheckInterval: 604800,
      SUAutomaticallyUpdate: false,
      SUSendProfileInfo: false,
      CFBundleDevelopmentRegion: "zh_CN",
      CFBundleLocalizations: ["zh_CN", "en"],
    },
  },
};
