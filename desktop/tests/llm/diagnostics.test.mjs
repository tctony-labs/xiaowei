import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayFailure } from "xiaowei-gateway";
import { generationDiagnostic } from "../../src/main/services/llm/worker/diagnostics.ts";

test("generation diagnostics keep safe categories without exposing upstream error bodies", () => {
  const secret = "api-key prompt response-body https://provider.invalid/?token=secret";
  for (const error of [secret, new Error(secret), { message: secret }, undefined]) {
    assert.deepEqual(generationDiagnostic(error, "openai-responses", 401), {
      cause: "http_error",
      status: 401,
    });
    assert.deepEqual(generationDiagnostic(error, "openai-responses"), {
      cause: "provider_error",
      status: undefined,
    });
  }
  const failure = new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: secret });
  assert.deepEqual(generationDiagnostic(failure, "openai-responses"), {
    cause: "gateway_error",
    code: "RESOURCE_EXHAUSTED",
  });
  assert.deepEqual(generationDiagnostic(`ECONNREFUSED ${secret}`, "openai-responses"), {
    cause: "network_error",
    code: "ECONNREFUSED",
  });
});
