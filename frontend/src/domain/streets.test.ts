import { assert, describe, it } from "@effect/vitest";
import { warningsNotice } from "./streets.js";

describe("warningsNotice", () => {
  it("returns null when there are no warnings", () => {
    assert.isNull(warningsNotice(undefined));
    assert.isNull(warningsNotice([]));
  });

  it("summarizes a single warning with generic French copy", () => {
    assert.strictEqual(
      warningsNotice(["Clamart (92023): Enedis transport failed"]),
      "Données partielles : 1 alerte — certaines communes n'ont pas pu être actualisées.",
    );
  });

  it("pluralizes multiple warnings without rendering upstream text", () => {
    const notice = warningsNotice(["SECRET_UPSTREAM_TEXT_1", "SECRET_UPSTREAM_TEXT_2"]);
    assert.strictEqual(
      notice,
      "Données partielles : 2 alertes — certaines communes n'ont pas pu être actualisées.",
    );
    assert.isFalse(notice?.includes("SECRET_UPSTREAM_TEXT") ?? true);
  });
});
