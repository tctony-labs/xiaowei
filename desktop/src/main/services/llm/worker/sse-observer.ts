// Observe complete SSE data events while forwarding the original bytes unchanged.
// Only parser state is retained; event bodies are never accumulated.
export function observeSseFetch(onFirstEvent: (receivedAtMs: number) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (
      !response.body ||
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream"
    ) {
      return response;
    }
    const decoder = new TextDecoder();
    let prefix = "";
    let lineLength = 0;
    let hasData = false;
    let afterCr = false;
    let observed = false;

    function finishLine() {
      if (lineLength === 0 && hasData) {
        observed = true;
        onFirstEvent(Date.now());
      } else if (prefix === "data" || prefix.startsWith("data:")) {
        hasData = true;
      }
      prefix = "";
      lineLength = 0;
    }

    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!observed) {
            for (const character of decoder.decode(chunk, { stream: true })) {
              if (afterCr && character === "\n") {
                afterCr = false;
                continue;
              }
              afterCr = false;
              if (character === "\r" || character === "\n") {
                finishLine();
                afterCr = character === "\r";
                if (observed) break;
              } else {
                // Five characters suffice to recognize data:, even for very long lines.
                if (prefix.length < 5) prefix += character;
                lineLength = Math.min(lineLength + 1, 6);
              }
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export const observableSseApis = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
]);
