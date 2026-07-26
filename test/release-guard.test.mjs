import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateCheckout,
  assertCandidateIsCurrentMain,
  classifyPublishedIntegrity,
  classifyTag,
} from "../scripts/release-guard.mjs";

const candidate = "a".repeat(40);

test("candidate guard rejects malformed, stale, and wrong checkouts", () => {
  assert.throws(
    () => assertCandidateIsCurrentMain("abc", "abc", "abc"),
    /full lowercase commit SHA/u,
  );
  assert.throws(
    () => assertCandidateIsCurrentMain(candidate, "b".repeat(40), candidate),
    /checked-out commit/u,
  );
  assert.throws(
    () => assertCandidateIsCurrentMain(candidate, candidate, "b".repeat(40)),
    /no longer current main/u,
  );
  assert.doesNotThrow(() =>
    assertCandidateIsCurrentMain(candidate, candidate, candidate),
  );
});

test("post-publication checkout guard is independent of a moving main", () => {
  assert.doesNotThrow(() => assertCandidateCheckout(candidate, candidate));
  assert.throws(
    () => assertCandidateCheckout(candidate, "b".repeat(40)),
    /checked-out commit/u,
  );
});

test("registry guard only permits an absent or byte-identical version", () => {
  assert.equal(classifyPublishedIntegrity("sha512-good", ""), "absent");
  assert.equal(
    classifyPublishedIntegrity("sha512-good", "sha512-good"),
    "exact",
  );
  assert.throws(
    () => classifyPublishedIntegrity("sha512-good", "sha512-other"),
    /different integrity/u,
  );
});

test("tag guard only creates a missing tag or accepts the exact candidate", () => {
  assert.equal(classifyTag(candidate, ""), "create");
  assert.equal(classifyTag(candidate, candidate), "exact");
  assert.throws(
    () => classifyTag(candidate, "b".repeat(40)),
    /different commit/u,
  );
});
