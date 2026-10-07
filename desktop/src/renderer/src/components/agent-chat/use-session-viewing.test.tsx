import { create } from "@bufbuild/protobuf";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Agent, SessionViewingReadySchema } from "xiaowei-contracts";
import { bindStreamHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices, type Services } from "../../services";
import { useSessionViewing } from "./use-session-viewing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Viewer({ services, id, viewing }: { services: Services; id?: string; viewing: boolean }) {
  useSessionViewing(services, id, viewing);
  return null;
}

test("visible session protection follows hiding, switching and unmounting", async () => {
  const host = new GatewayHost();
  const active = new Set<string>();
  const owner = host.registerOwner(
    "viewing",
    bindStreamHandlers(Agent, {
      async *subscribeSession() {},
      trackSessionViewing(request, _client, signal) {
        active.add(request.sessionId);
        return (async function* () {
          try {
            yield create(SessionViewingReadySchema);
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          } finally {
            active.delete(request.sessionId);
          }
        })();
      },
    }),
  );
  const services = createServices(() => host.client({ caller: "launcher", trusted: true }));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const view = render(<Viewer services={services} id="one" viewing={false} />);
  expect(active.size).toBe(0);
  view.rerender(<Viewer services={services} id="one" viewing />);
  await waitFor(() => expect([...active]).toEqual(["one"]));
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() => expect(active.size).toBe(0));
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() => expect([...active]).toEqual(["one"]));
  view.rerender(<Viewer services={services} id="two" viewing />);
  await waitFor(() => expect([...active]).toEqual(["two"]));
  view.rerender(<Viewer services={services} id="two" viewing={false} />);
  await waitFor(() => expect(active.size).toBe(0));
  view.rerender(<Viewer services={services} id="two" viewing />);
  await waitFor(() => expect([...active]).toEqual(["two"]));
  view.unmount();
  await waitFor(() => expect(active.size).toBe(0));
  owner.close();
});
