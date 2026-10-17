const base = require("./electron-builder.json");
const { feedUrl, publicKey, sparkleDirectory } = require("../scripts/release/sparkle.mjs");
const { signingConfiguration } = require("../scripts/release/signing.mjs");
const signed = process.env.XIAOWEI_MAC_SIGNED === "1";
const signing = signed ? signingConfiguration() : undefined;

module.exports = {
  ...base,
  // Builder collects dependency directories separately and ignores their npm files lists.
  // Reset that collector's default **/* before declaring the runtime files to copy.
  files: [
    {
      from: ".",
      filter: [
        "!**/*",
        ...base.files,
        ...["xiaowei-agent", "xiaowei-rust"].map(
          (name) => `node_modules/${name}/{index.js,package.json,${name}.darwin-arm64.node}`,
        ),
      ],
    },
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
