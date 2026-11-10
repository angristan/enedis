import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { requestContextLayer } from "./context.js";
import type { WorkerEnv } from "./config.js";
import {
  UpstreamCoordinatorClient,
  upstreamCoordinatorLayer,
} from "./http.js";
import type {
  CoordinatedRequest,
  CoordinatedResult,
} from "./upstream-coordinator.js";

const request: CoordinatedRequest = {
  provider: "Enedis",
  key: "commune:92023",
  operation: "enedis.fetch",
  url: "https://www.enedis.fr/panne-interruption-ajax?insee=92023",
  method: "GET",
  headers: {},
};

const okResult: CoordinatedResult = {
  ok: true,
  status: 200,
  statusText: "OK",
  text: "{}",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeEnv(fetchMock: ReturnType<typeof vi.fn>): WorkerEnv {
  return {
    UPSTREAM_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetchMock }),
    },
  } as unknown as WorkerEnv;
}

function coordinatorLayer(env: WorkerEnv) {
  return upstreamCoordinatorLayer(env).pipe(
    Layer.provideMerge(
      requestContextLayer({ waitUntil: () => {} } as unknown as ExecutionContext),
    ),
  );
}

describe("upstream coordinator client", () => {
  it.effect("retries once when the coordinator returns a transient 500", () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response("coordinator execution failed", { status: 500 }),
      )
      .mockResolvedValueOnce(jsonResponse(okResult));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const result = yield* client.request(request);
      assert.deepEqual(result, okResult);
      assert.strictEqual(fetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });

  it.effect("retries a dropped coordinator connection once", () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Durable Object unavailable"))
      .mockResolvedValueOnce(jsonResponse(okResult));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const result = yield* client.request(request);
      assert.deepEqual(result, okResult);
      assert.strictEqual(fetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });

  it.effect("does not retry non-retryable coordinator statuses", () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response("invalid coordinator request", { status: 400 }));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const error = yield* Effect.flip(client.request(request));
      assert.strictEqual(error._tag, "UpstreamTransportError");
      assert.match(String(error.cause), /coordinator returned 400/);
      assert.strictEqual(fetchMock.mock.calls.length, 1);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });

  it.effect("does not retry non-idempotent requests", () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response("coordinator execution failed", { status: 500 }));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const error = yield* Effect.flip(
        client.request({ ...request, method: "POST" }),
      );
      assert.strictEqual(error._tag, "UpstreamTransportError");
      assert.strictEqual(fetchMock.mock.calls.length, 1);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });

  it.effect("gives up after the second attempt on persistent 500s", () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response("coordinator execution failed", { status: 500 }));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const error = yield* Effect.flip(client.request(request));
      assert.strictEqual(error._tag, "UpstreamTransportError");
      assert.match(String(error.cause), /coordinator returned 500/);
      assert.strictEqual(fetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });
});
