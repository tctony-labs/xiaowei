import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
  type Authenticated,
  AuthenticatedSchema,
  ErrorCode,
  type KeyValue,
  KvEntrySchema,
  KvKeySchema,
} from "xiaowei-contracts";
import type { ServiceClient } from "xiaowei-gateway";
import { normalizeServerAddress } from "../../../shared/server-address";
import { AccountError } from "./errors";

const DEFAULT_SERVER = "https://xiaowei.tctony.com";

export interface AccountDocument {
  version: 1;
  deviceId: string;
  servers: string[];
  selectedServer: string;
  sessions: SavedSession[];
}

export interface SavedSession {
  server: string;
  authenticated: Authenticated;
}

function configurationJson(document: AccountDocument) {
  return JSON.stringify({
    version: document.version,
    deviceId: document.deviceId,
    servers: document.servers,
    selectedServer: document.selectedServer,
  });
}

export class AccountStore {
  private configuration = "";

  constructor(
    private readonly path: string,
    private readonly meta: Pick<ServiceClient<typeof KeyValue>, "get" | "set">,
  ) {}

  async load(): Promise<AccountDocument> {
    const entry = await this.meta.get(create(KvKeySchema, { key: "account.config" }));
    let document: AccountDocument;
    if (entry.json === undefined) {
      document = {
        version: 1,
        deviceId: randomUUID(),
        servers: [DEFAULT_SERVER],
        selectedServer: DEFAULT_SERVER,
        sessions: [],
      };
      const json = configurationJson(document);
      await this.meta.set(create(KvEntrySchema, { key: "account.config", json }));
      this.configuration = json;
      console.info("Account settings initialized in meta");
    } else {
      document = this.readConfiguration(entry.json);
      if (!document.servers.includes(DEFAULT_SERVER)) {
        document.servers.push(DEFAULT_SERVER);
        if (!document.selectedServer) document.selectedServer = DEFAULT_SERVER;
        await this.meta.set(
          create(KvEntrySchema, { key: "account.config", json: configurationJson(document) }),
        );
        console.info("Default account server added to settings");
      }
      this.configuration = configurationJson(document);
    }

    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      const sessions = value.version === 1 ? [value] : value.version === 2 ? value.sessions : null;
      if (!Array.isArray(sessions)) throw new Error("Invalid auth document");
      const servers = new Set<string>();
      document.sessions = sessions.map((session) => {
        if (typeof session.server !== "string" || !session.authenticated)
          throw new Error("Invalid saved session");
        const server = normalizeServerAddress(session.server);
        if (!document.servers.includes(server) || servers.has(server))
          throw new Error("Invalid saved session server");
        servers.add(server);
        return { server, authenticated: fromJson(AuthenticatedSchema, session.authenticated) };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AccountError(ErrorCode.INTERNAL_ERROR, "登录态无法读取，请检查本地 auth.json");
      }
    }
    return document;
  }

  private readConfiguration(contents: string): AccountDocument {
    try {
      const value = JSON.parse(contents);
      if (
        value.version !== 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          value.deviceId,
        ) ||
        !Array.isArray(value.servers) ||
        typeof value.selectedServer !== "string"
      )
        throw new Error("Invalid account document");

      const servers = value.servers.map((server: string) => normalizeServerAddress(server));
      if (
        new Set(servers).size !== servers.length ||
        (value.selectedServer && !servers.includes(value.selectedServer))
      ) {
        throw new Error("Invalid server selection");
      }
      return {
        version: 1,
        deviceId: value.deviceId,
        servers,
        selectedServer: value.selectedServer,
        sessions: [],
      };
    } catch {
      throw new AccountError(
        ErrorCode.INTERNAL_ERROR,
        "账号配置无法读取，请检查数据库 meta 中的 account.config",
      );
    }
  }

  async save(document: AccountDocument): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      if (document.sessions.length === 0) {
        await rm(this.path, { force: true });
      } else {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const auth = {
          version: 2,
          sessions: document.sessions.map((session) => ({
            server: session.server,
            authenticated: toJson(AuthenticatedSchema, session.authenticated),
          })),
        };
        await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, this.path);
      }
    } catch {
      throw new AccountError(ErrorCode.INTERNAL_ERROR, "保存登录态失败，请检查磁盘权限或空间");
    } finally {
      await rm(temporary, { force: true });
    }

    // Save credentials before publishing a new selection. Either selection remains recoverable.
    const configuration = configurationJson(document);
    if (configuration !== this.configuration) {
      try {
        await this.meta.set(create(KvEntrySchema, { key: "account.config", json: configuration }));
        this.configuration = configuration;
      } catch {
        throw new AccountError(ErrorCode.INTERNAL_ERROR, "保存账号配置失败，请检查数据库状态");
      }
    }
  }
}
