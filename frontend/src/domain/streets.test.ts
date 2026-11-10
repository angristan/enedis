import { assert, describe, it } from "@effect/vitest";
import { warningsNotice } from "./streets.js";

describe("warningsNotice", () => {
  it("returns null without warnings and a fixed French notice otherwise", () => {
    assert.isNull(warningsNotice(undefined));
    assert.strictEqual(
      warningsNotice(["Clamart (92023): Enedis transport failed"]),
      "Données partielles : certaines communes n'ont pas pu être actualisées.",
    );
  });
});
