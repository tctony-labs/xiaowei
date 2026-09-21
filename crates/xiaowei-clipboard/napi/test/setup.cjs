const { join } = require("node:path");
const { ClipboardHistory } = require("..");
const { Storage } = require("../../../xiaowei-storage/napi");

exports.open = async function open(directory, onChange = () => {}) {
  const { GatewayHost } = await import("../../../../gateway/ts/dist/core/registry.js");
  const { attachNative } = await import("../../../../gateway/ts/dist/main/native.js");
  const host = new GatewayHost();
  const storage = await Storage.open(join(directory, "storage.sqlite"));
  const storageOwner = await attachNative(host, "storage", storage.createGatewayEndpoint());
  const history = await ClipboardHistory.open(directory, onChange);
  const owner = await attachNative(host, "clipboard", history.createGatewayEndpoint());
  await history.initialize();
  return {
    history,
    async close() {
      await history.stopMonitoring();
      await owner.close();
      await storageOwner.close();
    },
  };
};
