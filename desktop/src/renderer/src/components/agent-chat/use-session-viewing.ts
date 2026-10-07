import { create } from "@bufbuild/protobuf";
import { useEffect, useState } from "react";
import { TrackSessionViewingRequestSchema } from "xiaowei-contracts";
import type { Services } from "../../services";

// Electron changes document visibility when its window hides or minimizes.
// Observation stays connected; only this viewing lease follows the visible page.
export function useSessionViewing(services: Services, sessionId: string | undefined, viewing: boolean) {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!sessionId || !viewing || !visible) return;
    let disposed = false;
    let stream: Awaited<ReturnType<ReturnType<Services["getAgentStream"]>["trackSessionViewing"]>> | undefined;
    void (async () => {
      try {
        const opened = await services
          .getAgentStream()
          .trackSessionViewing(create(TrackSessionViewingRequestSchema, { sessionId }));
        stream = opened;
        if (disposed) {
          await opened.cancel();
          return;
        }
        // Consume ready, then wait. Teardown cancels the stream and releases protection.
        for await (const _ready of opened) {
          if (disposed) break;
        }
      } catch (error) {
        if (!disposed) console.warn("Agent session viewing protection failed", sessionId, error);
      } finally {
        await stream?.cancel().catch(() => {});
      }
    })();
    return () => {
      disposed = true;
      void stream?.cancel().catch(() => {});
    };
  }, [services, sessionId, viewing, visible]);
}
