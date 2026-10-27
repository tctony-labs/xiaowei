import { create, fromBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  OpenUrlRequestSchema,
  SettingsChangedSchema,
  type SettingsSnapshot,
  TestWebSearchProviderRequestSchema,
  type UpdateSettingsRequest,
  UpdateSettingsRequestSchema,
  WebSearchApiKeyUpdateSchema,
  WebSearchProvider,
} from "proto-desktop-ts";
import { useEffect, useRef, useState } from "react";
import type { Subscription } from "xiaowei-gateway";
import { services as defaultServices, type Services } from "../../services";
import { AgentSettings } from "./AgentSettings";

const providers: Record<string, WebSearchProvider> = {
  bing: WebSearchProvider.BING,
  tavily: WebSearchProvider.TAVILY,
  brave: WebSearchProvider.BRAVE,
  serper: WebSearchProvider.SERPER,
};

function providerName(value: WebSearchProvider | undefined): string {
  return Object.keys(providers).find((name) => providers[name] === value) ?? "bing";
}

export function AgentSettingsPage({ services = defaultServices }: { services?: Services }) {
  const api = services.getSettings();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    let subscription: Subscription | undefined;
    void (async () => {
      const handle = await services
        .getGateway()
        .subscribe(SettingsChangedSchema.typeName, undefined, (bytes) => {
          const next = fromBinary(SettingsChangedSchema, bytes).snapshot;
          if (!active || !next) return;
          revision.current += 1;
          setSnapshot(next);
        });
      if (!active) {
        handle.close();
        return;
      }
      subscription = handle;
      const before = revision.current;
      const next = await api.get(create(EmptySchema));
      if (active && revision.current === before) setSnapshot(next);
    })().catch(() => {
      if (active) setError("加载搜索设置失败");
    });
    return () => {
      active = false;
      mounted.current = false;
      subscription?.close();
    };
  }, [api, services]);

  async function update(change: UpdateSettingsRequest["change"]) {
    setBusy(true);
    const before = revision.current;
    try {
      const next = await api.update(create(UpdateSettingsRequestSchema, { change }));
      if (mounted.current && revision.current === before) setSnapshot(next);
    } catch {
      throw new Error("保存搜索设置失败，请重试");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const settings = snapshot?.webSearch;
  return (
    <>
      {snapshot && (
        <AgentSettings
          values={{
            source: providerName(settings?.selectedProvider),
            effectiveSource: providerName(settings?.effectiveProvider),
            configured: settings?.configuredProviders.map(providerName) ?? [],
          }}
          busy={busy}
          onChange={(values) =>
            update({
              case: "webSearchProvider",
              value: providers[values.source],
            })
          }
          onSaveKey={(source, apiKey) =>
            update({
              case: "webSearchApiKey",
              value: create(WebSearchApiKeyUpdateSchema, { provider: providers[source], apiKey }),
            })
          }
          onTest={async () => {
            const result = await api.testWebSearchProvider(
              create(TestWebSearchProviderRequestSchema, {
                provider: settings?.selectedProvider ?? WebSearchProvider.BING,
              }),
            );
            if (!result.ok) throw new Error(result.error || "搜索源测试失败");
          }}
          onOpenUrl={(url) => {
            void services
              .getSystem()
              .openUrl(create(OpenUrlRequestSchema, { url }))
              .catch(() => setError("打开搜索源网站失败"));
          }}
        />
      )}
      {!snapshot && !error && <p role="status">加载搜索设置…</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
