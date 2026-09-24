const { join } = require("node:path");
const { ClipboardHistory } = require("..");
const { Storage } = require("../../../xiaowei-storage/napi");

exports.open = async function open(directory, onChange = () => {}) {
  const { GatewayHost } = await import("../../../../gateway/ts/dist/core/registry.js");
  const { attachRustNapi } = await import("../../../../gateway/ts/dist/main/rust-napi.js");
  const host = new GatewayHost();
  const storage = await Storage.open(join(directory, "storage.sqlite"));
  const storageOwner = await attachRustNapi(host, "storage", storage.createKeyValueGatewayEndpoint());
  const daoOwner = await attachRustNapi(host, "clipboard-dao", storage.createClipboardDaoGatewayEndpoint());
  const history = await ClipboardHistory.open(directory, onChange);
  const owner = await attachRustNapi(host, "clipboard", history.createGatewayEndpoint());
  await history.initialize();
  return {
    history,
    async close() {
      await history.stopMonitoring();
      await owner.close();
      await daoOwner.close();
      await storageOwner.close();
    },
  };
};
