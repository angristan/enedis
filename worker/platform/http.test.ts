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

type Outcome = "ok" | "network" | "overloaded" | 400 | 500;

interface RetryCase {
  readonly name: string;
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly method?: string;
  readonly expectedCalls: number;
  readonly expectOk: boolean;
  readonly errorMatch?: RegExp;
}

const cases: ReadonlyArray<RetryCase> = [
  {
    name: "retries a transient 500 once",
    outcomes: [500, "ok"],
    expectedCalls: 2,
    expectOk: true,
  },
  {
    name: "retries a dropped coordinator connection once",
    outcomes: ["network", "ok"],
    expectedCalls: 2,
    expectOk: true,
  },
  {
    name: "does not retry a 400 and includes the response body in the error",
    outcomes: [400],
    expectedCalls: 1,
    expectOk: false,
    errorMatch: /coordinator returned 400: .*invalid coordinator request/,
  },
  {
    name: "does not retry non-idempotent requests",
    outcomes: [500],
    method: "POST",
    expectedCalls: 1,
    expectOk: false,
  },
  {
    name: "does not retry when the Durable Object reports overload",
    outcomes: ["overloaded", "ok"],
    expectedCalls: 1,
    expectOk: false,
  },
  {
    name: "gives up after one retry on persistent 500s",
    outcomes: [500, 500],
    expectedCalls: 2,
    expectOk: false,
    errorMatch: /coordinator returned 500/,
  },
];

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

function runCase(testCase: RetryCase) {
  const fetchMock = vi.fn();
  for (const outcome of testCase.outcomes) {
    if (outcome === "ok") {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(okResult), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } else if (outcome === "network") {
      fetchMock.mockRejectedValueOnce(new Error("Durable Object unavailable"));
    } else if (outcome === "overloaded") {
      fetchMock.mockRejectedValueOnce(
        Object.assign(new Error("Durable Object overloaded"), {
          overloaded: true,
        }),
      );
    } else {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: outcome === 500
              ? "coordinator execution failed"
              : "invalid coordinator request",
          }),
          { status: outcome },
        ),
      );
    }
  }

  return Effect.gen(function* () {
    const client = yield* UpstreamCoordinatorClient;
    const fiber = yield* Effect.forkChild(
      client.request({ ...request, method: testCase.method ?? "GET" }),
    );
    yield* settleRetrySchedule;
    const exit = yield* Effect.exit(Fiber.join(fiber));
    if (testCase.expectOk) {
      assert.isTrue(Exit.isSuccess(exit));
    } else {
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit) && testCase.errorMatch !== undefined) {
        assert.match(Cause.pretty(exit.cause), testCase.errorMatch);
      }
    }
    assert.strictEqual(fetchMock.mock.calls.length, testCase.expectedCalls);
  }).pipe(Effect.provide(coordinatorLayer(makeEnv(fetchMock))));
}

describe("upstream coordinator client", () => {
  for (const testCase of cases) {
    it.effect(testCase.name, () => runCase(testCase));
  }
});
