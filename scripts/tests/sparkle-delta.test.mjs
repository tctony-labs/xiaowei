import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";
import { downloadDeltaBaselines, selectDeltaBaselines } from "../release/delta-baselines.mjs";
import { generateAppcast } from "../release/generate-appcast.mjs";
import { localUpdateOrigin } from "../release/local-update-config.mjs";
import { createLocalUpdateServer } from "../release/local-update-server.mjs";
import { verifyDeltaSigning } from "../release/signing.mjs";
import {
  ensureSparkle,
  releaseRepository,
  updateEnclosures,
  verifySignedAppcast,
  verifyUpdateArchive,
} from "../release/sparkle.mjs";

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function signingKeys() {
  const keys = generateKeyPairSync("ed25519");
  return {
    ...keys,
    key: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
    seed: keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"),
  };
}

function signedFeed(content, privateKey) {
  const signature = sign(null, Buffer.from(content), privateKey).toString("base64");
  return `${content}<!-- sparkle-signatures:
edSignature: ${signature}
length: ${Buffer.byteLength(content)}
-->`;
}

function publishedRelease(version, overrides = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{ name: `XiaoWei-${version}-arm64.zip` }, { name: "appcast.xml" }],
    ...overrides,
  };
}

function mockGitHub(t, handler) {
  const mock = t.mock.method(childProcess, "spawnSync", (command, args) => {
    assert.equal(command, "gh");
    return handler(args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
}

test("delta baselines are the three numerically latest older stable releases", () => {
  const releases = [
    publishedRelease("1.2.8"),
    publishedRelease("2.0.0"),
    publishedRelease("1.2.10"),
    publishedRelease("1.2.9"),
    publishedRelease("1.1.99"),
    publishedRelease("1.9.0", { draft: true }),
    publishedRelease("1.8.0", { prerelease: true }),
    publishedRelease("1.7.0-beta.1"),
    publishedRelease("01.6.0"),
    publishedRelease("2.1.0"),
  ];
  assert.deepEqual(
    selectDeltaBaselines(releases, "2.0.0").map((item) => item.version),
    ["1.2.10", "1.2.9", "1.2.8"],
  );
  assert.deepEqual(selectDeltaBaselines(releases, "0.1.0"), []);
});

test("missing baseline artifacts preserve full updates without selecting older releases", (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const releases = [
    publishedRelease("1.0.4", { assets: [{ name: "XiaoWei-1.0.4-arm64-debug-symbols.zip" }] }),
    publishedRelease("1.0.3", { assets: [{ name: "XiaoWei-1.0.3-arm64.zip" }] }),
    publishedRelease("1.0.2"),
    publishedRelease("1.0.1"),
  ];
  assert.deepEqual(selectDeltaBaselines(releases, "1.0.5"), [
    { version: "1.0.2", tag: "v1.0.2", archive: "XiaoWei-1.0.2-arm64.zip" },
  ]);
  assert.equal(warnings.mock.calls.length, 2);
});

test("downloaded original baselines require valid signed feeds and matching signed ZIPs", (t) => {
  const directory = temporaryDirectory(t, "xiaowei-delta-download-");
  const { key, privateKey } = signingKeys();
  const archive = Buffer.from("original published ZIP");
  const signature = sign(null, archive, privateKey).toString("base64");
  const filename = "XiaoWei-1.0.0-arm64.zip";
  const url = `https://github.com/${releaseRepository}/releases/download/v1.0.0/${filename}`;
  const content = `<item><sparkle:version>1.0.0</sparkle:version>
<enclosure url="${url}" length="${archive.length}" sparkle:edSignature="${signature}" /></item>`;
  const feed = signedFeed(content, privateKey);
  let corruption;
  let downloads = 0;
  mockGitHub(t, (args) => {
    if (args[0] === "api") {
      assert.ok(args.includes("--paginate"));
      assert.ok(args.includes("--slurp"));
      return { status: 0, stdout: JSON.stringify([[publishedRelease("1.0.0")], []]) };
    }
    assert.deepEqual(args.slice(0, 3), ["release", "download", "v1.0.0"]);
    assert.deepEqual(args.slice(5, 9), ["--pattern", filename, "--pattern", "appcast.xml"]);
    downloads += 1;
    const destination = args[args.indexOf("--dir") + 1];
    writeFileSync(join(destination, filename), corruption === "archive" ? "changed ZIP" : archive);
    writeFileSync(
      join(destination, "appcast.xml"),
      corruption === "feed" ? feed.replace("<item>", "<item> ") : feed,
    );
    return { status: 0 };
  });

  const baselines = downloadDeltaBaselines({
    directory: join(directory, "valid"),
    version: "1.0.1",
    key,
  });
  assert.deepEqual(baselines, [
    { version: "1.0.0", archivePath: join(directory, "valid/1.0.0", filename) },
  ]);
  for (const scenario of ["feed", "archive"]) {
    corruption = scenario;
    assert.throws(() =>
      downloadDeltaBaselines({ directory: join(directory, scenario), version: "1.0.1", key }),
    );
  }
  assert.equal(downloads, 3);
});

test("history and download failures abort rather than silently publishing without deltas", (t) => {
  const directory = temporaryDirectory(t, "xiaowei-delta-download-error-");
  const { key } = signingKeys();
  let failedCommand = "api";
  mockGitHub(t, (args) => {
    if (args[0] === failedCommand) return { status: 1 };
    return { status: 0, stdout: JSON.stringify([[publishedRelease("1.0.0")]]) };
  });
  assert.throws(
    () => downloadDeltaBaselines({ directory, version: "1.0.1", key }),
    /gh failed with status 1/,
  );
  failedCommand = "release";
  assert.throws(
    () => downloadDeltaBaselines({ directory, version: "1.0.1", key }),
    /gh failed with status 1/,
  );
});

test("verification matches the requested version and distinguishes full and delta archives", () => {
  const { key, privateKey } = signingKeys();
  const archive = Buffer.from("signed full archive");
  const patch = Buffer.from("signed delta");
  const archiveSignature = sign(null, archive, privateKey).toString("base64");
  const patchSignature = sign(null, patch, privateKey).toString("base64");
  const url = "https://example.test/full.zip";
  const patchUrl = "https://example.test/update.delta";
  const xml = `<rss><channel>
<item><sparkle:version>1.0.0</sparkle:version><enclosure url="old.zip" /></item>
<item><sparkle:version>1.0.1</sparkle:version>
<description><![CDATA[<item><sparkle:version>1.0.1</sparkle:version></item>]]></description>
<sparkle:deltas><enclosure url="${patchUrl}" sparkle:deltaFrom="1.0.0"
length="${patch.length}" sparkle:edSignature="${patchSignature}" /></sparkle:deltas>
<enclosure url="${url}" length="${archive.length}" sparkle:edSignature="${archiveSignature}" />
</item></channel></rss>`;
  verifyUpdateArchive({ xml, archive, key, version: "1.0.1", url });
  const input = { xml, archive: patch, key, version: "1.0.1", url: patchUrl, deltaFrom: "1.0.0" };
  verifyUpdateArchive(input);
  for (const change of [
    { deltaFrom: undefined },
    { deltaFrom: "0.9.0" },
    { version: "1.0.0" },
    { url },
    { archive: Buffer.from("changed data") },
    { xml: xml.replace(patchSignature, archiveSignature) },
    { xml: xml.replace(`length="${patch.length}"`, 'length="1"') },
  ]) {
    assert.throws(() => verifyUpdateArchive({ ...input, ...change }));
  }
});

test("the release shell publishes actual delta files and accepts an empty delta set", (t) => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/macos-release.yml", import.meta.url), "utf8"),
  );
  const steps = workflow.jobs.release.steps;
  const publish = steps.find((step) => step.name === "Publish GitHub Release");
  const upload = steps.find((step) => step.name === "Upload release artifacts");
  assert.ok(upload.with.path.split("\n").includes("desktop/dist/*.delta"));

  const directory = temporaryDirectory(t, "xiaowei-delta-release-shell-");
  const bin = join(directory, "bin");
  const dist = join(directory, "desktop/dist");
  mkdirSync(bin);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(bin, "gh"), '#!/bin/bash\nprintf \'%s\\0\' "$@" > "$XIAOWEI_TEST_GH_ARGS"\n', {
    mode: 0o755,
  });
  for (const filename of [
    "XiaoWei-1.0.1-arm64.dmg",
    "XiaoWei-1.0.1-arm64.zip",
    "XiaoWei-1.0.1-arm64-debug-symbols.zip",
    "appcast.xml",
  ]) {
    writeFileSync(join(dist, filename), filename);
  }
  const argumentFile = join(directory, "arguments");
  for (const deltas of [[], ["XiaoWei1.0.1-1.0.0.delta", "XiaoWei1.0.1-0.9.0.delta"]]) {
    for (const filename of deltas) writeFileSync(join(dist, filename), filename);
    const result = childProcess.spawnSync(
      "/bin/bash",
      ["-e", "-o", "pipefail", "-c", publish.run],
      {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: bin, RELEASE_TAG: "v1.0.1", XIAOWEI_TEST_GH_ARGS: argumentFile },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(argumentFile, "utf8").split("\0").filter(Boolean);
    assert.deepEqual(args.slice(0, 3), ["release", "create", "v1.0.1"]);
    assert.deepEqual(
      args.filter((arg) => arg.endsWith(".delta")).sort(),
      deltas.map((filename) => `desktop/dist/${filename}`).sort(),
    );
    assert.ok(args.every((arg) => !arg.includes("*")));
  }
});

function runTool(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function appFixtures(t, versions, name = "Delta") {
  const directory = temporaryDirectory(t, "xiaowei-sparkle-delta-");
  const sparkle = ensureSparkle();
  const keys = signingKeys();
  const shared = randomBytes(256 * 1024);
  const bundles = versions.map((version) => {
    const app = join(directory, version, `${name}.app`);
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents/Resources"), { recursive: true });
    copyFileSync("/usr/bin/true", join(app, "Contents/MacOS/Delta"));
    cpSync(join(sparkle, "Sparkle.framework"), join(app, "Contents/Frameworks/Sparkle.framework"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    writeFileSync(join(app, "Contents/Resources/shared"), shared);
    writeFileSync(join(app, "Contents/Resources/version"), version);
    const addition = version === versions.at(-1) ? "new-only" : "old-only";
    writeFileSync(join(app, "Contents/Resources", addition), version);
    writeFileSync(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.tctony.xiaowei.delta-test</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>Delta</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>SUPublicEDKey</key><string>${keys.key}</string>
  <key>SURequireSignedFeed</key><true/>
</dict></plist>`,
    );
    runTool("codesign", ["--deep", "--force", "--sign", "-", app]);
    const archivePath = join(directory, `${name}-${version}.zip`);
    runTool("ditto", ["-c", "-k", "--keepParent", app, archivePath]);
    return { version, app, archivePath };
  });
  return { directory, sparkle, bundles, ...keys };
}

function bundleContents(directory) {
  return readdirSync(directory, { recursive: true })
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      let content;
      if (stat.isSymbolicLink()) content = readlinkSync(path);
      else if (stat.isFile())
        content = createHash("sha256").update(readFileSync(path)).digest("hex");
      return { name, mode: stat.mode, content };
    });
}

const macOnly = { skip: process.platform !== "darwin" };

test(
  "incompatible old resource signatures skip deltas while preserving a signed full update",
  macOnly,
  (t) => {
    const { directory, bundles, key, seed } = appFixtures(t, ["1.0.0", "1.0.1"]);
    const baseline = bundles[0];
    const latest = bundles[1];
    runTool("codesign", [
      "--force",
      "--sign",
      "-",
      join(baseline.app, "Contents/Resources/shared"),
    ]);
    runTool("codesign", ["--force", "--sign", "-", baseline.app]);
    assert.throws(() => verifyDeltaSigning(baseline.app), /code-signing xattrs/);
    verifyDeltaSigning(latest.app);
    runTool("ditto", ["-c", "-k", "--keepParent", baseline.app, baseline.archivePath]);
    const output = join(directory, "source/appcast.xml");
    const deltas = generateAppcast({
      ...latest,
      key,
      privateKey: seed,
      urlPrefix: "https://example.test/",
      output,
      baselines: [baseline],
    });
    assert.deepEqual(deltas, []);
    const feed = readFileSync(output);
    verifySignedAppcast({ feed, key });
    const xml = feed.toString("utf8");
    assert.equal(updateEnclosures(xml, latest.version).length, 1);
    verifyUpdateArchive({
      xml,
      archive: readFileSync(latest.archivePath),
      key,
      version: latest.version,
      url: "https://example.test/Delta-1.0.1.zip",
    });
  },
);

test(
  "real Sparkle generates at most three signed deltas and reconstructs the exact signed app",
  macOnly,
  (t) => {
    const fixture = appFixtures(t, ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4"]);
    const { directory, bundles, key, seed, sparkle } = fixture;
    const latest = bundles.at(-1);
    const source = join(directory, "source");
    const output = join(source, "appcast.xml");
    const input = {
      ...latest,
      key,
      privateKey: seed,
      urlPrefix: "https://example.test/",
      output,
    };
    const deltas = generateAppcast({ ...input, baselines: bundles.slice(0, -1) });
    assert.deepEqual(deltas.map((item) => item.deltaFrom).sort(), ["1.0.1", "1.0.2", "1.0.3"]);
    const feed = readFileSync(output);
    verifySignedAppcast({ feed, key });
    const xml = feed.toString("utf8");
    assert.equal([...xml.matchAll(/<item>/g)].length, 1);
    assert.equal(updateEnclosures(xml, latest.version).length, 4);
    const expected = bundleContents(latest.app);
    for (const delta of deltas) {
      const baseline = bundles.find((item) => item.version === delta.deltaFrom);
      const patched = join(directory, `patched-${delta.deltaFrom}.app`);
      const patch = join(source, delta.filename);
      assert.equal(readFileSync(patch).length, delta.length);
      runTool(join(sparkle, "bin/BinaryDelta"), ["apply", baseline.app, patched, patch]);
      assert.deepEqual(bundleContents(patched), expected);
      runTool("codesign", ["--verify", "--deep", "--strict", patched]);
    }

    const wrongBase = join(directory, "wrong-base.app");
    const rejectedBaseline = bundles.find((item) => item.version === deltas[0].deltaFrom);
    cpSync(rejectedBaseline.app, wrongBase, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(wrongBase, "Contents/Resources/extra"), "changed installed application");
    const rejected = childProcess.spawnSync(
      join(sparkle, "bin/BinaryDelta"),
      ["apply", wrongBase, join(directory, "rejected.app"), join(source, deltas[0].filename)],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /hash|match/i);

    const fullOutput = join(source, "appcast-full.xml");
    assert.deepEqual(generateAppcast({ ...input, output: fullOutput }), []);
    const fullFeed = readFileSync(fullOutput);
    verifySignedAppcast({ feed: fullFeed, key });
    assert.equal(updateEnclosures(fullFeed.toString("utf8"), latest.version).length, 1);
  },
);

test(
  "local HTTP serves signed deltas and full-only feeds, isolating archive and delta corruption",
  macOnly,
  async (t) => {
    const { directory, bundles, key, seed, sparkle } = appFixtures(
      t,
      ["1.0.0", "1.0.1"],
      "Delta Test",
    );
    const latest = bundles[1];
    const source = join(directory, "source");
    mkdirSync(source);
    const archive = basename(latest.archivePath);
    copyFileSync(latest.archivePath, join(source, archive));
    const input = {
      ...latest,
      key,
      privateKey: seed,
      urlPrefix: `${localUpdateOrigin}/`,
    };
    const deltas = generateAppcast({
      ...input,
      output: join(source, "appcast.xml"),
      baselines: [bundles[0]],
    });
    assert.equal(deltas.length, 1);
    generateAppcast({ ...input, output: join(source, "appcast-full.xml") });
    writeFileSync(
      join(directory, "test.json"),
      JSON.stringify({ key, archive, newVersion: latest.version, deltas }),
    );

    for (const scenario of [
      "valid",
      "full-only",
      "invalid-feed",
      "invalid-archive",
      "invalid-delta",
    ]) {
      const server = createLocalUpdateServer(directory, scenario);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(`${origin}/appcast.xml`);
        const feed = Buffer.from(await response.arrayBuffer());
        if (scenario === "invalid-feed") {
          assert.throws(() => verifySignedAppcast({ feed, key }));
          continue;
        }
        verifySignedAppcast({ feed, key });
        const xml = feed.toString("utf8");
        const fullOnly = scenario === "full-only" || scenario === "invalid-archive";
        assert.equal(updateEnclosures(xml, latest.version).length, fullOnly ? 1 : 2);
        const download = await fetch(`${origin}/${encodeURIComponent(archive)}`);
        const full = Buffer.from(await download.arrayBuffer());
        const verification = {
          xml,
          archive: full,
          key,
          version: latest.version,
          url: `${localUpdateOrigin}/${encodeURIComponent(archive)}`,
        };
        if (scenario === "invalid-archive") assert.throws(() => verifyUpdateArchive(verification));
        else verifyUpdateArchive(verification);

        const delta = deltas[0];
        const patchUrl = `${origin}/${encodeURIComponent(delta.filename)}`;
        const head = await fetch(patchUrl, { method: "HEAD" });
        const patchResponse = await fetch(patchUrl);
        if (fullOnly) {
          assert.equal(head.status, 404);
          assert.equal(patchResponse.status, 404);
        } else {
          assert.equal(head.status, 200);
          assert.equal(Number(head.headers.get("content-length")), delta.length);
          const patch = Buffer.from(await patchResponse.arrayBuffer());
          const patchVerification = {
            ...verification,
            archive: patch,
            url: `${localUpdateOrigin}/${encodeURIComponent(delta.filename)}`,
            deltaFrom: delta.deltaFrom,
          };
          if (scenario === "invalid-delta") {
            assert.throws(() => verifyUpdateArchive(patchVerification), /signature does not match/);
          } else {
            verifyUpdateArchive(patchVerification);
            if (scenario === "valid") {
              const patchPath = join(directory, "downloaded.delta");
              const patched = join(directory, "downloaded.app");
              writeFileSync(patchPath, patch);
              runTool(join(sparkle, "bin/BinaryDelta"), [
                "apply",
                bundles[0].app,
                patched,
                patchPath,
              ]);
              assert.deepEqual(bundleContents(patched), bundleContents(latest.app));
              runTool("codesign", ["--verify", "--deep", "--strict", patched]);
            }
          }
        }
        assert.equal((await fetch(`${origin}/appcast-full.xml`)).status, 404);
        assert.equal((await fetch(`${origin}/test.json`)).status, 404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  },
);
