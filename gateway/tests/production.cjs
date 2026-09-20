// Normal addons must never retain fixture exports after integration-test builds.
const assert = require("node:assert/strict");
for (const name of ["search", "clipboard"]) {
  const addon = require(`../../crates/xiaowei-${name}/napi`);
  assert.equal(addon.createGatewayFixture, undefined);
  assert.equal(addon.GatewayEndpoint.prototype.fixtureInvoke, undefined);
  const endpoint = addon.createGatewayEndpoint();
  const manifest = JSON.parse(endpoint.manifest());
  assert.deepEqual(manifest.routes, []);
  assert.deepEqual(manifest.events, []);
  endpoint
    .close()
    .then((result) => {
      assert.ok(Buffer.isBuffer(result));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
