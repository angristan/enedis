import { assert, describe, it, vi } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
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

const settleRetrySchedule = Effect.gen(function* () {
  for (let index = 0; index < 10; index += 1) {
    yield* Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
    yield* TestClock.adjust("100 millis");
  }
});

describe("upstream coordinator client", () => {
  it.effect("retries once when the coordinator returns a transient 500", () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('{"error":"coordinator execution failed"}', { status: 500 }),
      )
      .mockResolvedValueOnce(jsonResponse(okResult));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const fiber = yield* Effect.forkChild(client.request(request));
      yield* settleRetrySchedule;
      const result = yield* Fiber.join(fiber);
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
      const fiber = yield* Effect.forkChild(client.request(request));
      yield* settleRetrySchedule;
      const result = yield* Fiber.join(fiber);
      assert.deepEqual(result, okResult);
      assert.strictEqual(fetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });

  it.effect("does not retry non-retryable coordinator statuses", () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(
        new Response('{"error":"invalid coordinator request"}', { status: 400 }),
      );

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const error = yield* Effect.flip(client.request(request));
      assert.strictEqual(error._tag, "UpstreamTransportError");
      assert.match(String(error.cause), /coordinator returned 400/);
      assert.match(String(error.cause), /invalid coordinator request/);
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

  it.effect("does not retry when the Durable Object reports overload", () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Durable Object overloaded"), {
          overloaded: true,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(okResult));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const error = yield* Effect.flip(client.request(request));
      assert.strictEqual(error._tag, "UpstreamTransportError");
      assert.strictEqual(fetchMock.mock.calls.length, 1);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });

  it.effect("gives up after the second attempt on persistent 500s", () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response("coordinator execution failed", { status: 500 }));

    return Effect.gen(function* () {
      const client = yield* UpstreamCoordinatorClient;
      const fiber = yield* Effect.forkChild(client.request(request));
      yield* settleRetrySchedule;
      const exit = yield* Effect.exit(Fiber.join(fiber));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause);
        assert.match(pretty, /UpstreamTransportError/);
        assert.match(pretty, /coordinator returned 500/);
      }
      assert.strictEqual(fetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
  });
});
