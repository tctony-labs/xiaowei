const base = require("./electron-builder.mac.cjs");
const {
  localUpdateAppId,
  localUpdateDirectory,
  localUpdateName,
  localUpdateOrigin,
} = require("../scripts/release/local-update-config.mjs");
const { releaseVersion } = require("../scripts/release/sparkle.mjs");
const version = releaseVersion(process.env.XIAOWEI_LOCAL_UPDATE_VERSION);

if (process.env.XIAOWEI_MAC_SIGNED !== "0") throw new Error("Local update tests require ad-hoc signing");

module.exports = {
  ...base,
  appId: localUpdateAppId,
  productName: localUpdateName,
  buildVersion: version,
  extraMetadata: { version, productName: localUpdateName },
  directories: { output: `${localUpdateDirectory}/${version}` },
  mac: {
    ...base.mac,
    extendInfo: {
      ...base.mac.extendInfo,
      SUFeedURL: `${localUpdateOrigin}/appcast.xml`,
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
};
