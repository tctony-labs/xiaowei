import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkRelease, deriveUpdatePublicKey, verifyUpdateKeyPair } from "../release/check-release.mjs";
import { localUpdateAppId, localUpdateName, localUpdateOrigin } from "../release/local-update-config.mjs";
import { createLocalUpdateServer } from "../release/local-update-server.mjs";
import { notarizeDmg, signingConfiguration, verifySigningDetails } from "../release/signing.mjs";
import { publicKey, releaseVersion, verifySignedAppcast, verifyUpdateArchive } from "../release/sparkle.mjs";

const { version } = JSON.parse(readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8"));

function mockNotarization(t, staplerResult) {
  const calls = [];
  t.mock.method(childProcess, "spawnSync", (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "notarytool") return { status: 0, stdout: '{"status":"Accepted","id":"test-submission"}' };
    if (args[0] === "stapler") return staplerResult(args[1]);
    return { status: 0 };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const waits = t.mock.method(Atomics, "wait", () => "timed-out");
  const warnings = t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  return { calls, waits, warnings };
}

test("DMG ticket operations recover from CloudKit errors before Gatekeeper assessment", (t) => {
  const attempts = { staple: 0, validate: 0 };
  const { calls, waits, warnings } = mockNotarization(t, (action) => {
    attempts[action] += 1;
    return { status: attempts[action] === 1 ? 68 : 0 };
  });

  notarizeDmg("/tmp/Test App.dmg", {});

  assert.deepEqual(attempts, { staple: 2, validate: 2 });
  assert.deepEqual(
    waits.mock.calls.map((call) => call.arguments[3]),
    [5000, 5000],
  );
  assert.equal(warnings.mock.callCount(), 2);
  assert.equal(calls.filter((call) => call[1] === "notarytool").length, 1);
  assert.equal(calls.at(-1)[0], "spctl");
});

test("persistent CloudKit errors exhaust bounded backoff and prevent Gatekeeper assessment", (t) => {
  const { calls, waits } = mockNotarization(t, () => ({ status: 68 }));

  assert.throws(() => notarizeDmg("/tmp/Test.dmg", {}), /stapler staple failed with status 68/);

  assert.equal(calls.filter((call) => call[1] === "stapler").length, 4);
  assert.deepEqual(
    waits.mock.calls.map((call) => call.arguments[3]),
    [5000, 10000, 20000],
  );
  assert.equal(
    calls.some((call) => call[0] === "spctl"),
    false,
  );
});

test("stapler rejects non-CloudKit failures without retrying", (t) => {
  const { calls, waits } = mockNotarization(t, () => ({ status: 65 }));

  assert.throws(() => notarizeDmg("/tmp/Test.dmg", {}), /stapler staple failed with status 65/);

  assert.equal(calls.filter((call) => call[1] === "stapler").length, 1);
  assert.equal(waits.mock.callCount(), 0);
  assert.equal(
    calls.some((call) => call[0] === "spctl"),
    false,
  );
});

test("stapler preserves process launch errors without retrying", (t) => {
  const error = new Error("spawn xcrun ENOENT");
  const { waits } = mockNotarization(t, () => ({ status: null, error }));

  assert.throws(
    () => notarizeDmg("/tmp/Test.dmg", {}),
    (actual) => actual === error,
  );
  assert.equal(waits.mock.callCount(), 0);
});

test("successful ticket operations proceed without waiting or warnings", (t) => {
  const { calls, waits, warnings } = mockNotarization(t, () => ({ status: 0 }));

  notarizeDmg("/tmp/Test.dmg", {});

  assert.equal(calls.filter((call) => call[1] === "stapler").length, 2);
  assert.equal(waits.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 0);
  assert.equal(calls.at(-1)[0], "spctl");
});

test("formal signatures require the selected Developer ID team and hardened runtime", () => {
  const team = "ABCDEFGHIJ";
  const details = `Executable=/tmp/XiaoWei.app/Contents/MacOS/XiaoWei
CodeDirectory v=20500 size=400 flags=0x10000(runtime) hashes=8+7 location=embedded
Authority=Developer ID Application: Release Publisher (${team})
Authority=Developer ID Certification Authority
TeamIdentifier=${team}`;
  verifySigningDetails(details, team);
  assert.throws(() => verifySigningDetails(details, "KLMNOPQRST"), /Team ID/);
  assert.throws(() => verifySigningDetails(details.replace("Developer ID Application", "Apple Development"), team));
  assert.throws(() => verifySigningDetails(details.replace("0x10000(runtime)", "0x0(none)"), team), /hardened runtime/);
  assert.throws(() => verifySigningDetails("Signature=adhoc\nTeamIdentifier=not set", team));
  verifySigningDetails(details.replace("0x10000(runtime)", "0x0(none)"), team, false);
});

test("formal release preflight rejects missing credentials, nonmatching tags and keys before building", () => {
  const keys = generateKeyPairSync("ed25519");
  const seed = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const key = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const env = {
    CSC_LINK: "explicit-test-certificate",
    CSC_KEY_PASSWORD: "test-only-password",
    CSC_NAME: "Developer ID Application: Release Publisher (ABCDEFGHIJ)",
    APPLE_TEAM_ID: "ABCDEFGHIJ",
    APPLE_ID: "publisher@example.test",
    APPLE_APP_SPECIFIC_PASSWORD: "test-only-notarization-password",
    SPARKLE_ED_PUBLIC_KEY: key,
    SPARKLE_ED_PRIVATE_KEY: seed.toString("base64"),
  };
  assert.deepEqual(signingConfiguration(env), { team: "ABCDEFGHIJ", identity: "Release Publisher (ABCDEFGHIJ)" });
  const configPath = fileURLToPath(new URL("../../desktop/electron-builder.mac.cjs", import.meta.url));
  const configResult = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)})))`],
    { encoding: "utf8", env: { ...env, XIAOWEI_MAC_SIGNED: "1", PATH: process.env.PATH } },
  );
  assert.equal(configResult.status, 0, configResult.stderr);
  const config = JSON.parse(configResult.stdout);
  assert.equal(config.mac.identity, "Release Publisher (ABCDEFGHIJ)");
  assert.equal(config.mac.type, "distribution");
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.dmg.sign, true);
  assert.deepEqual(checkRelease(`v${version}`, version, env), { tag: `v${version}`, version, team: "ABCDEFGHIJ" });
  assert.throws(() => checkRelease("wrong-tag", version, {}), /Release tag/);
  for (const name of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "APPLE_TEAM_ID",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
  ]) {
    assert.throws(() => signingConfiguration({ ...env, [name]: "" }), new RegExp(name));
  }
  assert.throws(() => signingConfiguration({ ...env, APPLE_TEAM_ID: "personal-name" }), /Team ID/);
  assert.throws(() => signingConfiguration({ ...env, CSC_NAME: "Apple Development: Release Publisher (ABCDEFGHIJ)" }));
  assert.throws(() => signingConfiguration({ ...env, CSC_NAME: "Developer ID Application: Other (KLMNOPQRST)" }));
  assert.throws(() => verifyUpdateKeyPair(key, ""), /SPARKLE_ED_PRIVATE_KEY/);
  assert.throws(() => verifyUpdateKeyPair(key, "invalid"), /Base64/);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  assert.throws(() => verifyUpdateKeyPair(other.subarray(-32).toString("base64"), seed.toString("base64")), /match/);

  // Legacy official exports contain the clamped SHA-512 seed expansion and the public key.
  const expanded = createHash("sha512").update(seed).digest();
  expanded[0] &= 248;
  expanded[31] &= 63;
  expanded[31] |= 64;
  const legacy = Buffer.concat([expanded, Buffer.from(key, "base64")]).toString("base64");
  verifyUpdateKeyPair(key, legacy);
  assert.equal(deriveUpdatePublicKey(seed.toString("base64")), key);
  assert.equal(deriveUpdatePublicKey(seed.toString("base64").replace(/=+$/, "")), key);
  assert.equal(deriveUpdatePublicKey(legacy), key);
  verifyUpdateKeyPair(key, seed.toString("base64").replace(/=+$/, ""));
});

test("release inputs reject prereleases, noncanonical versions and invalid verification keys", () => {
  for (const version of ["", "v1.2.3", "1.2.3-beta.1", "1.2", "01.2.3", "1.2.3\n"]) {
    assert.throws(() => releaseVersion(version));
  }
  assert.equal(releaseVersion("1.2.3"), "1.2.3");
  for (const key of [undefined, "", "placeholder", Buffer.alloc(31).toString("base64"), "!".repeat(44)]) {
    assert.throws(() => publicKey(key));
  }
  const { publicKey: key } = generateKeyPairSync("ed25519");
  const encoded = key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  assert.equal(publicKey(encoded), encoded);
});

test("appcast generation rejects an unrelated tag before using credentials or invoking Sparkle", () => {
  const script = fileURLToPath(new URL("../release/generate-appcast.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "wrong/tag"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected release tag/);
  assert.equal(result.stdout, "");
});

test("appcast generation requires an explicit signing key rather than using the user's Keychain", () => {
  const script = fileURLToPath(new URL("../release/generate-appcast.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, `v${version}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SPARKLE_ED_PRIVATE_KEY is required/);
  assert.equal(result.stdout, "");
});

test("release verification checks actual archive signatures, the public key, version and download destination", () => {
  const keys = generateKeyPairSync("ed25519");
  const key = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const archive = Buffer.from("test update archive");
  const signature = sign(null, archive, keys.privateKey).toString("base64");
  const url = "https://github.com/tctony-labs/xiaowei/releases/download/v1.2.3/XiaoWei-1.2.3-arm64.zip";
  const xml = `<sparkle:version>1.2.3</sparkle:version>
    <enclosure url="${url}" length="${archive.length}" sparkle:edSignature="${signature}" />`;
  const input = { xml, archive, key, version: "1.2.3", url };
  verifyUpdateArchive(input);
  assert.throws(() => verifyUpdateArchive({ ...input, archive: Buffer.from("tampered contents!!") }));
  assert.throws(() => verifyUpdateArchive({ ...input, version: "1.2.4" }));
  assert.throws(() => verifyUpdateArchive({ ...input, url: "https://example.com/update.zip" }));
  assert.throws(() => verifyUpdateArchive({ ...input, xml: xml.replace(signature, "") }));
  const other = generateKeyPairSync("ed25519").publicKey;
  const otherKey = other.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  assert.throws(() => verifyUpdateArchive({ ...input, key: otherKey }), /signature does not match/);
});

test("packaging keeps local HTTP and test identity out of production and enables required Sparkle validation", () => {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const env = {
    PATH: process.env.PATH,
    SPARKLE_ED_PUBLIC_KEY: key.subarray(-32).toString("base64"),
    XIAOWEI_MAC_SIGNED: "0",
    XIAOWEI_LOCAL_UPDATE_VERSION: "0.1.1",
  };
  for (const local of [false, true]) {
    const configPath = new URL(`../../desktop/electron-builder.mac${local ? "-test" : ""}.cjs`, import.meta.url);
    const result = spawnSync(
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(fileURLToPath(configPath))})))`],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.hardenedRuntime, false);
    assert.equal(config.mac.extendInfo.SURequireSignedFeed, true);
    assert.equal(config.mac.extendInfo.SUVerifyUpdateBeforeExtraction, true);
    assert.equal(config.appId, local ? localUpdateAppId : "com.tctony.xiaowei");
    if (local) {
      assert.equal(config.productName, localUpdateName);
      assert.equal(config.extraMetadata.version, "0.1.1");
      assert.equal(config.mac.extendInfo.SUFeedURL, `${localUpdateOrigin}/appcast.xml`);
      assert.deepEqual(config.mac.extendInfo.NSAppTransportSecurity, { NSAllowsLocalNetworking: true });
    } else {
      assert.equal(config.mac.extendInfo.NSAppTransportSecurity, undefined);
      assert.match(config.mac.extendInfo.SUFeedURL, /^https:\/\/github.com\//);
    }
  }
});

test("local HTTP source serves exact signed bytes, failure scenarios and no unrelated files", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "local-update-server-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const key = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const archive = Buffer.from("PK local update test archive");
  const filename = "XiaoWei Local Update-0.1.1-arm64.zip";
  const url = `${localUpdateOrigin}/${encodeURIComponent(filename)}`;
  const signature = sign(null, archive, keys.privateKey).toString("base64");
  const content = `<sparkle:version>0.1.1</sparkle:version>
    <enclosure url="${url}" length="${archive.length}" sparkle:edSignature="${signature}" />`;
  const feedSignature = sign(null, Buffer.from(content), keys.privateKey).toString("base64");
  const metadata = `edSignature: ${feedSignature}\nlength: ${Buffer.byteLength(content)}\n`;
  const xml = `${content}<!-- sparkle-signatures:\n${metadata}-->`;
  mkdirSync(join(directory, "source"));
  writeFileSync(join(directory, "source/appcast.xml"), xml);
  writeFileSync(join(directory, "source", filename), archive);
  writeFileSync(join(directory, "test.json"), JSON.stringify({ key, archive: filename, newVersion: "0.1.1" }));

  for (const scenario of ["valid", "invalid-feed", "invalid-archive"]) {
    const server = createLocalUpdateServer(directory, scenario);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const feed = await fetch(`${origin}/appcast.xml`);
      assert.equal(feed.status, 200);
      assert.equal(feed.headers.get("cache-control"), "no-store");
      const servedXml = await feed.text();
      assert.equal(servedXml === xml, scenario !== "invalid-feed");
      const signedFeed = { feed: Buffer.from(servedXml), key };
      if (scenario === "invalid-feed") assert.throws(() => verifySignedAppcast(signedFeed));
      else verifySignedAppcast(signedFeed);
      const head = await fetch(`${origin}/${encodeURIComponent(filename)}`, { method: "HEAD" });
      assert.equal(Number(head.headers.get("content-length")), archive.length);
      const download = await fetch(`${origin}/${encodeURIComponent(filename)}`);
      const servedArchive = Buffer.from(await download.arrayBuffer());
      const input = { xml, archive: servedArchive, key, version: "0.1.1", url };
      if (scenario === "invalid-archive") assert.throws(() => verifyUpdateArchive(input));
      else verifyUpdateArchive(input);
      assert.equal((await fetch(`${origin}/test.json`)).status, 404);
      assert.equal((await fetch(`${origin}/appcast.xml`, { method: "POST" })).status, 405);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
