const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { Agent } = require("xiaowei-agent");

async function journal(directory, sessionId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === `${sessionId}.jsonl`) return join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await journal(join(directory, entry.name), sessionId);
      if (found) return found;
    }
  }
}

async function ageSession(root, sessionId, timestamp) {
  const original = await journal(join(root, "sessions"), sessionId);
  const entries = (await readFile(original, "utf8")).trimEnd().split("\n").map(JSON.parse);
  assert.equal(entries.length, 2, "aging fixture must be a blank session");
  assert.equal(entries[0].payload.type, "session_header");
  assert.equal(entries[1].payload.type, "meta");
  entries[0].timestamp_ms = timestamp;
  entries[1].timestamp_ms = timestamp;

  const date = new Date(timestamp);
  const directory = join(
    root,
    "sessions",
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
  );
  const path = join(directory, `${sessionId}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  if (path !== original) await rm(original);
  return path;
}

test("formal Agent owns SQLite and archive/delete; titles never append JSONL", async () => {
  const pb = await import("xiaowei-contracts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const root = await mkdtemp(join(tmpdir(), "agent-sqlite-"));
  const host = new GatewayHost();
  const caller = host.client({ caller: "desktop", trusted: true });
  const api = bindClient(pb.Agent, caller);
  let agent;
  let endpoint;
  let db;
  try {
    agent = await Agent.open(root);
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const creation = create(pb.CreateSessionRequestSchema, {
      clientRequestId: "01900000-0000-7000-8000-000000000001",
      config: { modelRef: "unavailable-model", reasoning: "high" },
    });
    const first = (await api.createSession(creation)).session;
    assert.equal(first.autoTitleEnabled, true);
    assert.equal((await api.createSession(creation)).session.sessionId, first.sessionId);
    const path = await journal(join(root, "sessions"), first.sessionId);
    const original = await readFile(path);
    await api.setSessionTitle(
      create(pb.SetSessionTitleRequestSchema, { sessionId: first.sessionId, title: "手动标题" }),
    );
    assert.deepEqual(await readFile(path), original);
    db = new DatabaseSync(join(root, "sessions.sqlite"));
    const columns = db
      .prepare("PRAGMA table_info(session)")
      .all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      "session_id",
      "title",
      "auto_title_enabled",
      "created_at_ms",
      "updated_at_ms",
      "archived",
      "archive_revision",
      "deleting",
    ]);
    assert.equal(db.prepare("SELECT title FROM session WHERE session_id = ?").get(first.sessionId).title, "手动标题");
    db.exec(
      `CREATE TRIGGER fail_title BEFORE UPDATE ON session
       BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END`,
    );
    const unchanged = await api.setSessionTitle(
      create(pb.SetSessionTitleRequestSchema, { sessionId: first.sessionId, title: "手动标题" }),
    );
    assert.equal(unchanged.metadataRevision, 2n);
    await assert.rejects(
      api.setSessionTitle(
        create(pb.SetSessionTitleRequestSchema, {
          sessionId: first.sessionId,
          title: "不能提交的标题",
        }),
      ),
    );
    assert.equal(
      (await api.readSession(create(pb.ReadSessionRequestSchema, { sessionId: first.sessionId }))).session.title,
      "手动标题",
    );
    db.exec("DROP TRIGGER fail_title");
    await api.setSessionTitle(
      create(pb.SetSessionTitleRequestSchema, { sessionId: first.sessionId, title: "恢复后的标题" }),
    );
    assert.deepEqual(await readFile(path), original);
    for (let i = 2; i <= 18; i++) {
      await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: `01900000-0000-7000-8000-${i.toString().padStart(12, "0")}`,
          config: { modelRef: "unavailable-model" },
        }),
      );
    }
    const page = await api.listSessions(create(pb.ListSessionsRequestSchema, { pageSize: 5 }));
    assert.equal(page.sessions.length, 5);
    assert.ok(page.continuation);
    const next = await api.listSessions(
      create(pb.ListSessionsRequestSchema, { pageSize: 5, continuation: page.continuation }),
    );
    assert.equal(next.sessions.length, 5);
    assert.equal(new Set([...page.sessions, ...next.sessions].map((session) => session.sessionId)).size, 10);
    await api.setSessionArchived(
      create(pb.SetSessionArchivedRequestSchema, {
        sessionId: first.sessionId,
        archived: true,
        expectedArchiveRevision: 1n,
      }),
    );
    await assert.rejects(api.readSession(create(pb.ReadSessionRequestSchema, { sessionId: first.sessionId })));
    await assert.rejects(
      api.setSessionTitle(create(pb.SetSessionTitleRequestSchema, { sessionId: first.sessionId, title: "blocked" })),
    );
    assert.equal(
      (await api.listSessions(create(pb.ListSessionsRequestSchema, { archived: true }))).sessions[0].title,
      "恢复后的标题",
    );
    db.close();
    db = undefined;
    await agent.close();
    await endpoint.close();
    agent = undefined;
    endpoint = undefined;
    // Known registered files and an unregistered corrupt file are never read at startup/list.
    const orphan = join(root, "sessions", "2026", "10", "orphan.jsonl");
    await mkdir(join(root, "sessions", "2026", "10"), { recursive: true });
    await writeFile(orphan, "invalid orphan\n");
    agent = await Agent.open(root);
    endpoint = await attachRustNapi(host, "reopened-agent", agent.createGatewayEndpoint());
    const archived = (await api.listSessions(create(pb.ListSessionsRequestSchema, { archived: true }))).sessions[0];
    assert.equal(archived.archiveRevision, 2n);
    await api.setSessionArchived(
      create(pb.SetSessionArchivedRequestSchema, {
        sessionId: first.sessionId,
        archived: false,
        expectedArchiveRevision: 2n,
      }),
    );
    const retried = (await api.readSession(create(pb.ReadSessionRequestSchema, { sessionId: first.sessionId })))
      .session;
    assert.equal(retried.sessionId, first.sessionId);
    assert.equal(retried.title, "恢复后的标题");
    assert.equal(retried.autoTitleEnabled, false);
    assert.equal(retried.metadataRevision, 1n);
    const deletion = await api.deleteSession(
      create(pb.DeleteSessionRequestSchema, {
        targets: [
          {
            sessionId: first.sessionId,
            expectedMetadataRevision: retried.metadataRevision,
          },
        ],
      }),
    );
    assert.equal(deletion.results[0].status, pb.DeleteSessionStatus.DELETED);
    assert.equal((await api.listSessions(create(pb.ListSessionsRequestSchema))).sessions.length, 17);
    db = new DatabaseSync(join(root, "sessions.sqlite"));
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM session WHERE session_id = ?").get(first.sessionId).count,
      0,
    );
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await assert.rejects(readdir(join(root, "deletions")), { code: "ENOENT" });
  } finally {
    await agent?.close();
    await endpoint?.close();
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("formal Agent batch delete respects searched page targets, restoration and partial SQL failure", async () => {
  const pb = await import("xiaowei-contracts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const root = await mkdtemp(join(tmpdir(), "agent-batch-"));
  const host = new GatewayHost();
  const agent = await Agent.open(root);
  const endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
  const api = bindClient(pb.Agent, host.client({ caller: "settings", trusted: true }));
  let db;
  try {
    for (let i = 0; i < 5; i++) {
      const view = (
        await api.createSession(
          create(pb.CreateSessionRequestSchema, {
            clientRequestId: `01900000-0000-7000-8000-${i.toString().padStart(12, "0")}`,
            config: { modelRef: "unavailable-model" },
          }),
        )
      ).session;
      await api.setSessionTitle(
        create(pb.SetSessionTitleRequestSchema, {
          sessionId: view.sessionId,
          title: i === 4 ? "other" : `match ${i}`,
        }),
      );
      await api.setSessionArchived(
        create(pb.SetSessionArchivedRequestSchema, {
          sessionId: view.sessionId,
          archived: true,
          expectedArchiveRevision: 1n,
        }),
      );
    }
    const listing = create(pb.ListSessionsRequestSchema, { archived: true, query: "match", pageSize: 2 });
    const page = await api.listSessions(listing);
    assert.equal(page.sessions.length, 2);
    assert.ok(page.continuation);
    const targets = page.sessions.map((session) => ({
      sessionId: session.sessionId,
      expectedMetadataRevision: session.metadataRevision,
      expectedArchiveRevision: session.archiveRevision,
    }));
    await assert.rejects(
      api.deleteSession(
        create(pb.DeleteSessionRequestSchema, {
          targets: [targets[0], targets[0]],
        }),
      ),
    );
    await api.setSessionArchived(
      create(pb.SetSessionArchivedRequestSchema, {
        sessionId: targets[0].sessionId,
        archived: false,
        expectedArchiveRevision: 2n,
      }),
    );
    const deleted = await api.deleteSession(create(pb.DeleteSessionRequestSchema, { targets }));
    assert.deepEqual(
      deleted.results.map((result) => result.status),
      [pb.DeleteSessionStatus.SKIPPED, pb.DeleteSessionStatus.DELETED],
    );
    assert.equal(
      (
        await api.readSession(
          create(pb.ReadSessionRequestSchema, {
            sessionId: targets[0].sessionId,
          }),
        )
      ).found,
      true,
    );
    const remaining = await api.listSessions(listing);
    assert.equal(remaining.sessions.length, 2);
    assert.equal(remaining.continuation, "");
    const nextTargets = remaining.sessions.map((session) => ({
      sessionId: session.sessionId,
      expectedMetadataRevision: session.metadataRevision,
      expectedArchiveRevision: session.archiveRevision,
    }));
    db = new DatabaseSync(join(root, "sessions.sqlite"));
    // IDs originate from the validated native API and contain only UUID characters.
    db.exec(`CREATE TRIGGER fail_delete BEFORE UPDATE ON session
      WHEN NEW.deleting = 1 AND OLD.session_id = '${nextTargets[0].sessionId}'
      BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END`);
    const partial = await api.deleteSession(create(pb.DeleteSessionRequestSchema, { targets: nextTargets }));
    assert.deepEqual(
      partial.results.map((result) => result.status),
      [pb.DeleteSessionStatus.FAILED, pb.DeleteSessionStatus.NOT_EXECUTED],
    );
    assert.ok(partial.results[0].error);
    assert.equal((await api.listSessions(listing)).sessions.length, 2);
    db.exec("DROP TRIGGER fail_delete");
    const retry = await api.deleteSession(create(pb.DeleteSessionRequestSchema, { targets: nextTargets }));
    assert.ok(retry.results.every((result) => result.status === pb.DeleteSessionStatus.DELETED));
    assert.equal((await api.listSessions(listing)).sessions.length, 0);
    const unaffected = await api.listSessions(create(pb.ListSessionsRequestSchema, { archived: true }));
    assert.deepEqual(
      unaffected.sessions.map((session) => session.title),
      ["other"],
    );
  } finally {
    db?.close();
    await agent.close();
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("formal Agent persists retention policy and automatically archives/deletes on activation", async () => {
  const pb = await import("xiaowei-contracts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient, bindStreamClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const root = await mkdtemp(join(tmpdir(), "agent-retention-"));
  const host = new GatewayHost();
  const caller = host.client({ caller: "settings", trusted: true });
  const api = bindClient(pb.Agent, caller);
  let agent;
  let endpoint;
  let db;
  try {
    agent = await Agent.open(root);
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const defaults = await api.getSessionRetentionPolicy(create(pb.GetSessionRetentionPolicyRequestSchema));
    assert.equal(defaults.archiveAfterDays, 3);
    assert.equal(defaults.deleteAfterDays, 0);
    await assert.rejects(
      api.setSessionRetentionPolicy(
        create(pb.SetSessionRetentionPolicyRequestSchema, {
          policy: { archiveAfterDays: 0, deleteAfterDays: 30 },
        }),
      ),
    );
    await api.setSessionRetentionPolicy(
      create(pb.SetSessionRetentionPolicyRequestSchema, {
        policy: { archiveAfterDays: 3, deleteAfterDays: 30 },
      }),
    );
    const ids = [];
    for (let i = 1; i <= 2; i++) {
      const response = await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: `01900000-0000-7000-8000-${i.toString().padStart(12, "0")}`,
          config: { modelRef: "unavailable-model" },
        }),
      );
      ids.push(response.session.sessionId);
    }
    const streamApi = bindStreamClient(pb.Agent, caller);
    // Repeated cancellation must release native leases, not exhaust the core's viewer limit.
    for (let i = 0; i < 70; i++) {
      const viewing = await streamApi.trackSessionViewing(
        create(pb.TrackSessionViewingRequestSchema, {
          sessionId: ids[0],
        }),
      );
      assert.equal((await viewing.next()).done, false);
      const cancelled = assert.rejects(viewing.next());
      await viewing.cancel();
      await cancelled;
    }
    let deletedPath;
    db = new DatabaseSync(join(root, "sessions.sqlite"));
    db.exec("CREATE TRIGGER fail_policy BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'failure'); END");
    await assert.rejects(
      api.setSessionRetentionPolicy(
        create(pb.SetSessionRetentionPolicyRequestSchema, {
          policy: { archiveAfterDays: 7, deleteAfterDays: 0 },
        }),
      ),
    );
    assert.equal(
      (await api.getSessionRetentionPolicy(create(pb.GetSessionRetentionPolicyRequestSchema))).deleteAfterDays,
      30,
    );
    db.exec("DROP TRIGGER fail_policy");
    await agent.close();
    await endpoint.close();
    agent = undefined;
    endpoint = undefined;
    const day = 86_400_000;
    const update = db.prepare("UPDATE session SET created_at_ms = ?, updated_at_ms = ? WHERE session_id = ?");
    for (let i = 0; i < ids.length; i++) {
      const time = Date.now() - (i === 0 ? 40 : 4) * day;
      const path = await ageSession(root, ids[i], time);
      if (i === 0) deletedPath = path;
      update.run(time, time, ids[i]);
    }
    db.close();
    db = undefined;
    agent = await Agent.open(root);
    endpoint = await attachRustNapi(host, "agent-reopened", agent.createGatewayEndpoint());
    const deadline = Date.now() + 5000;
    let archived;
    do {
      archived = await api.listSessions(create(pb.ListSessionsRequestSchema, { archived: true }));
      if (archived.sessions.length === 1 && archived.sessions[0].sessionId === ids[1]) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.deepEqual(
      archived.sessions.map((session) => session.sessionId),
      [ids[1]],
    );
    assert.equal((await api.listSessions(create(pb.ListSessionsRequestSchema))).sessions.length, 0);
    assert.equal(
      (await api.getSessionRetentionPolicy(create(pb.GetSessionRetentionPolicyRequestSchema))).deleteAfterDays,
      30,
    );
    await agent.close();
    await endpoint.close();
    agent = undefined;
    endpoint = undefined;
    await assert.rejects(readFile(deletedPath), { code: "ENOENT" });
  } finally {
    await agent?.close();
    await endpoint?.close();
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("saving policy through Gateway restarts live maintenance; failed KV save preserves the policy", async () => {
  const pb = await import("xiaowei-contracts");
  const { create } = await import("@bufbuild/protobuf");
  const { bindClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const root = await mkdtemp(join(tmpdir(), "agent-policy-restart-"));
  const host = new GatewayHost();
  const api = bindClient(pb.Agent, host.client({ caller: "settings", trusted: true }));
  let agent;
  let endpoint;
  let db;
  try {
    agent = await Agent.open(root);
    endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
    const session = (
      await api.createSession(
        create(pb.CreateSessionRequestSchema, {
          clientRequestId: "01900000-0000-7000-8000-000000000001",
          config: { modelRef: "unavailable-model" },
        }),
      )
    ).session;
    let path = await journal(join(root, "sessions"), session.sessionId);
    await agent.close();
    await endpoint.close();
    agent = undefined;
    endpoint = undefined;
    db = new DatabaseSync(join(root, "sessions.sqlite"));
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
      ["meta", "session"],
    );
    path = await ageSession(root, session.sessionId, 1);
    db.exec("UPDATE session SET created_at_ms = 1, updated_at_ms = 1");
    db.close();
    db = undefined;
    agent = await Agent.open(root);
    endpoint = await attachRustNapi(host, "reopened-agent", agent.createGatewayEndpoint());
    const waitForList = async (count) => {
      const deadline = Date.now() + 5000;
      do {
        const response = await api.listSessions(create(pb.ListSessionsRequestSchema, { archived: true }));
        if (response.sessions.length === count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      assert.fail(`archive count did not become ${count}`);
    };
    await waitForList(1);
    db = new DatabaseSync(join(root, "sessions.sqlite"));
    db.exec(`CREATE TRIGGER fail_policy BEFORE UPDATE ON meta
      WHEN NEW.key = 'retention.delete_after_days' BEGIN SELECT RAISE(ABORT, 'failure'); END`);
    const request = create(pb.SetSessionRetentionPolicyRequestSchema, {
      policy: { archiveAfterDays: 7, deleteAfterDays: 30 },
    });
    await assert.rejects(api.setSessionRetentionPolicy(request));
    const unchanged = await api.getSessionRetentionPolicy(create(pb.GetSessionRetentionPolicyRequestSchema));
    assert.equal(unchanged.archiveAfterDays, 3);
    assert.equal(unchanged.deleteAfterDays, 0);
    assert.ok(await readFile(path));
    db.exec("DROP TRIGGER fail_policy");
    await api.setSessionRetentionPolicy(request);
    await waitForList(0);
    await agent.close();
    await endpoint.close();
    agent = undefined;
    endpoint = undefined;
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await agent?.close();
    await endpoint?.close();
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});
