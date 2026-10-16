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
    // Node exports select dist/node; retain its ESM/CJS entries and tokenizer support.
    "!**/node_modules/@google/genai/dist/web/**",
    "!**/node_modules/@google/genai/dist/index.{mjs,cjs}",
    // Keep the package's Node main and fetch-blob's explicit ES2018 ponyfill import.
    "!**/node_modules/web-streams-polyfill/dist/*.{mjs,min.js}",
    "!**/node_modules/web-streams-polyfill/dist/{polyfill.es6.js,polyfill.es2018.js,ponyfill.js,ponyfill.es6.js}",
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
