import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const image = process.env.XIAOWEI_DEPLOY_TEST_IMAGE;
assert.ok(image, "Set XIAOWEI_DEPLOY_TEST_IMAGE to the locally built server image");

const source = dirname(fileURLToPath(import.meta.url));
// The home directory is shared with local Docker VMs; macOS TMPDIR often is not.
const root = mkdtempSync(join(homedir(), ".xiaowei-delivery-"));
const project = `xiaowei-delivery-${randomBytes(6).toString("hex")}`;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("XIAOWEI_") || key.startsWith("COMPOSE_")) {
    delete env[key];
  }
}
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--project-directory",
  root,
  "--env-file",
  join(root, "config/.env"),
  "--file",
  join(root, "compose.yaml"),
];

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    env,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function compose(args, options) {
  return docker([...composeArgs, ...args], options);
}

function sql(statement) {
  return compose(
    ["exec", "-T", "db", "psql", "-U", "xiaowei", "-d", "xiaowei", "-v", "ON_ERROR_STOP=1"],
    {
      input: statement,
    },
  );
}

let address;
async function request(path, { body, token, code = 0, method = "POST" } = {}) {
  const headers = { Connection: "close", "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${address}${path}`, {
    method,
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `${path}: unexpected HTTP status`);
  const result = await response.json();
  assert.equal(result.code, code, `${path}: unexpected business code`);
  return result.data;
}

function stage(message) {
  console.log(message);
}

try {
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "data"));
  copyFileSync(join(source, "compose.xiaowei.yaml"), join(root, "compose.yaml"));
  copyFileSync(join(source, "server.example.yaml"), join(root, "config/server.yaml"));
  const databasePassword = `${randomBytes(24).toString("base64url")}$#`;
  const password = "Delivery $test#pass";
  const email = "deployment-test@example.invalid";
  const databaseEnv = [
    `XIAOWEI_SERVER_IMAGE=${image}`,
    `XIAOWEI_DATABASE_PASSWORD='${databasePassword}'`,
    "XIAOWEI_DATABASE_NAME=xiaowei",
    "XIAOWEI_DATABASE_USER=xiaowei",
    "XIAOWEI_SERVER_PORT=0",
  ];
  writeFileSync(
    join(root, "config/.env"),
    `${[
      ...databaseEnv,
      `XIAOWEI_BOOTSTRAP_ADMIN_EMAIL=${email}`,
      `XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD='${password}'`,
    ].join("\n")}\n`,
    { mode: 0o600 },
  );

  const config = JSON.parse(compose(["config", "--format", "json"]).toString());
  assert.ok(
    !config.services.db.ports?.length,
    "Production PostgreSQL must not publish a host port",
  );
  assert.equal(config.services.server.ports[0].host_ip, "127.0.0.1");
  const checkArgs = [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "server",
    "--check-config",
    "--config",
    "/etc/xiaowei/server.yaml",
  ];
  compose(checkArgs);
  assert.equal(compose(["ps", "--all", "--quiet"]).toString().trim(), "");
  assert.ok(!existsSync(join(root, "data/postgres")), "Configuration check started the database");
  assert.throws(() => compose([...checkArgs.slice(0, -1), "/etc/xiaowei/missing.yaml"]));
  stage("Configuration check exits successfully without dependencies and rejects missing files");

  stage("Starting an isolated production Compose project");
  compose(["up", "--detach", "--wait", "--wait-timeout", "120"]);
  address = `http://${compose(["port", "server", "10001"]).toString().trim()}`;
  await request("/api/common.Health/Ready");

  const serverID = compose(["ps", "--quiet", "server"]).toString().trim();
  const inspection = JSON.parse(docker(["inspect", serverID]).toString())[0];
  assert.equal(inspection.Config.User, "65532");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  const deviceID = randomUUID();
  const loginBody = {
    device_id: deviceID,
    device_name: "Delivery test",
    password: { email, password },
  };
  await request("/api/auth.Auth/Login", {
    body: { ...loginBody, password: { email, password: "wrong-password" } },
    code: 10100,
  });
  const login = await request("/api/auth.Auth/Login", { body: loginBody });
  assert.ok(login.authenticated, "Password login did not establish a session");
  const credentials = login.authenticated;
  await request("/api/auth.Auth/GetCurrentUser", { token: credentials.tokens.access_token });
  stage("Administrator initialization and real container login passed");

  const invalidCheck = [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "-e",
    "XIAOWEI_AUTH_ACCESS_TOKEN_TTL=secret-invalid-duration",
    "server",
    "--check-config",
    "--config",
    "/etc/xiaowei/server.yaml",
  ];
  assert.throws(
    () => compose(invalidCheck),
    (error) => {
      const output = `${error.stdout}${error.stderr}`;
      assert.ok(output.includes("XIAOWEI_AUTH_ACCESS_TOKEN_TTL"));
      assert.ok(!output.includes("secret-invalid-duration"));
      return error.status !== 0;
    },
  );
  assert.equal(compose(["ps", "--quiet", "server"]).toString().trim(), serverID);
  await request("/api/auth.Auth/GetCurrentUser", { token: credentials.tokens.access_token });
  stage("Failed candidate configuration leaves the old server and session running");

  writeFileSync(join(root, "config/.env"), `${databaseEnv.join("\n")}\n`, { mode: 0o600 });
  compose([
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "120",
    "server",
  ]);
  address = `http://${compose(["port", "server", "10001"]).toString().trim()}`;
  const restored = await request("/api/auth.Auth/GetCurrentUser", {
    token: credentials.tokens.access_token,
  });
  assert.ok(
    restored.user.user_id === credentials.user.user_id,
    "Container replacement changed account identity",
  );
  const refreshed = await request("/api/auth.Auth/Refresh", {
    body: { refresh_token: credentials.tokens.refresh_token },
  });
  await request("/api/auth.Auth/Refresh", {
    body: { refresh_token: credentials.tokens.refresh_token },
    code: 10002,
  });
  await request("/api/auth.Auth/GetCurrentUser", { token: refreshed.access_token });
  stage("Container replacement, persistent session and refresh rotation passed");

  compose(["stop", "db"]);
  const unavailable = await fetch(`${address}/api/common.Health/Ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(unavailable.status, 200);
  assert.ok((await unavailable.json()).code !== 0, "Database outage must fail readiness");
  assert.throws(() => compose(["exec", "-T", "server", "/xiaowei-healthcheck"]));
  compose(["up", "--detach", "--wait", "--wait-timeout", "120"]);
  await request("/api/common.Health/Ready");
  await request("/api/auth.Auth/GetCurrentUser", { token: refreshed.access_token });
  stage("HTTP 200 database failure correctly fails the container readiness probe");

  writeFileSync(
    join(root, "release.txt"),
    `sha=isolated-test\nrun_id=isolated-test\nimage=${image}\n`,
  );
  const backupArgs = [join(source, "backup.sh"), root, project];
  const backupOptions = { env, timeout: 180_000, stdio: ["pipe", "pipe", "pipe"] };
  execFileSync("bash", backupArgs, backupOptions);
  const backupPath = join(root, "backups/latest.tar");
  const firstBackup = readFileSync(backupPath);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.throws(() => execFileSync("bash", backupArgs, backupOptions));
  assert.deepEqual(
    readFileSync(backupPath),
    firstBackup,
    "Retry overwrote the pending rollback point",
  );

  compose(["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "120", "server"]);
  address = `http://${compose(["port", "server", "10001"]).toString().trim()}`;
  await request("/api/auth.Auth/GetCurrentUser", { token: refreshed.access_token });
  rmSync(join(root, "backups/upgrade-pending"));

  // Inject a pg_dump failure to verify preservation and automatic old-service recovery.
  const faultBin = join(root, "fault-bin");
  mkdirSync(faultBin);
  const dockerPath = execFileSync("which", ["docker"], { env }).toString().trim();
  const quotedDocker = `'${dockerPath.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(faultBin, "docker"),
    [
      "#!/bin/sh",
      'case "$*" in *"exec pg_dump"*) exit 91 ;; esac',
      `exec ${quotedDocker} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  assert.throws(
    () =>
      execFileSync("bash", backupArgs, {
        ...backupOptions,
        env: { ...env, PATH: `${faultBin}:${env.PATH}` },
      }),
    (error) => {
      assert.equal(error.status, 91);
      assert.ok(error.stderr.toString().includes("restarting the old server"));
      return true;
    },
  );
  assert.deepEqual(
    readFileSync(backupPath),
    firstBackup,
    "Failed backup replaced the previous backup",
  );
  assert.ok(!existsSync(join(root, "backups/upgrade-pending")));
  address = `http://${compose(["port", "server", "10001"]).toString().trim()}`;
  await request("/api/auth.Auth/GetCurrentUser", { token: refreshed.access_token });
  stage("Backup failure preserves the previous snapshot and restores the old service");

  execFileSync("bash", backupArgs, backupOptions);
  assert.deepEqual(readdirSync(join(root, "backups")).sort(), ["latest.tar", "upgrade-pending"]);
  const restoredDir = join(root, "rollback");
  mkdirSync(restoredDir, { mode: 0o700 });
  execFileSync("tar", ["-xpf", backupPath, "-C", restoredDir]);
  assert.deepEqual(
    readFileSync(join(restoredDir, "config/.env")),
    readFileSync(join(root, "config/.env")),
  );
  assert.deepEqual(
    readFileSync(join(restoredDir, "compose.yaml")),
    readFileSync(join(root, "compose.yaml")),
  );
  assert.deepEqual(
    readFileSync(join(restoredDir, "release.txt")),
    readFileSync(join(root, "release.txt")),
  );
  sql(
    "CREATE TABLE failed_migration_marker (id integer); TRUNCATE users CASCADE; DELETE FROM admin_bootstrap;\n",
  );
  // Recreate the database: pg_restore --clean alone leaves objects introduced by the failed version.
  compose(["exec", "-T", "db", "dropdb", "-U", "xiaowei", "--force", "xiaowei"]);
  compose(["exec", "-T", "db", "createdb", "-U", "xiaowei", "--owner", "xiaowei", "xiaowei"]);
  compose(["exec", "-T", "db", "pg_restore", "-U", "xiaowei", "-d", "xiaowei", "--exit-on-error"], {
    input: readFileSync(join(restoredDir, "database.dump")),
  });
  assert.match(
    sql("SELECT to_regclass('public.failed_migration_marker') IS NULL;\n").toString(),
    /\n t\s*\n/,
  );
  copyFileSync(join(restoredDir, "compose.yaml"), join(root, "compose.yaml"));
  renameSync(join(root, "config"), join(restoredDir, "replaced-config"));
  execFileSync("cp", ["-pR", join(restoredDir, "config"), join(root, "config")]);
  assert.equal(statSync(join(root, "config/server.yaml")).mode & 0o777, 0o644);
  assert.equal(statSync(join(root, "config/.env")).mode & 0o777, 0o600);
  copyFileSync(join(restoredDir, "release.txt"), join(root, "release.txt"));
  compose(["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "120", "server"]);
  address = `http://${compose(["port", "server", "10001"]).toString().trim()}`;
  await request("/api/auth.Auth/GetCurrentUser", { token: refreshed.access_token });
  await request("/api/auth.Auth/Logout", { token: refreshed.access_token, method: "POST" });
  await request("/api/auth.Auth/GetCurrentUser", { token: refreshed.access_token, code: 10002 });
  rmSync(join(root, "backups/upgrade-pending"));
  stage(
    "Single rollback snapshot restores configuration, database, accounts and sessions; logout passed",
  );

  const logs = compose(["logs", "--no-color", "server"]).toString();
  for (const secret of [
    databasePassword,
    password,
    email,
    refreshed.access_token,
    refreshed.refresh_token,
  ]) {
    assert.ok(!logs.includes(secret), "Deployment logs contain a secret");
  }
  stage("Production Compose acceptance passed");
} finally {
  try {
    compose(["down", "--volumes", "--remove-orphans"]);
    // PostgreSQL owns this isolated bind directory; remove it through the same container user boundary.
    docker([
      "run",
      "--rm",
      "--volume",
      `${join(root, "data")}:/cleanup`,
      "--entrypoint",
      "sh",
      "postgres:17.9-bookworm",
      "-c",
      "rm -rf /cleanup/postgres",
    ]);
    rmSync(root, { recursive: true, force: true });
  } catch {
    console.error(
      `Could not fully clean the isolated deployment project ${project}; files: ${root}`,
    );
    process.exitCode = 1;
  }
}
