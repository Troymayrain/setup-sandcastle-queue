import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateCheckout,
  assertCandidateIsCurrentMain,
  classifyPublishedIntegrity,
  classifyTag,
  readRegistryIntegrity,
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

test("registry reader distinguishes an unpublished version from registry failures", async () => {
  assert.equal(
    await readRegistryIntegrity("example", "1.0.0", async () => ({
      ok: false,
      status: 404,
    })),
    "",
  );
  await assert.rejects(
    readRegistryIntegrity("example", "1.0.0", async () => ({
      ok: false,
      status: 401,
    })),
    /HTTP 401/u,
  );
});

test("registry reader cancels a hanging request at its deadline", async () => {
  const signal = AbortSignal.timeout(1);
  await assert.rejects(
    readRegistryIntegrity(
      "example",
      "1.0.0",
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(
            () => reject(new Error("abort signal did not fire")),
            1_000,
          );
          const abort = () => {
            clearTimeout(keepAlive);
            reject(options.signal.reason);
          };
          if (options.signal.aborted) {
            abort();
          } else {
            options.signal.addEventListener("abort", abort, { once: true });
          }
        }),
      signal,
    ),
    /timeout/u,
  );
});

test("registry reader returns only a valid published integrity", async () => {
  let requested;
  const integrity = await readRegistryIntegrity(
    "example",
    "1.0.0",
    async (url, options) => {
      requested = { options, url };
      return {
        json: async () => ({ dist: { integrity: "sha512-good" } }),
        ok: true,
        status: 200,
      };
    },
  );
  assert.equal(integrity, "sha512-good");
  assert.equal(requested.url, "https://registry.npmjs.org/example/1.0.0");
  assert.deepEqual(requested.options.headers, {
    accept: "application/json",
  });
  assert.ok(requested.options.signal instanceof AbortSignal);
  await assert.rejects(
    readRegistryIntegrity("example", "1.0.0", async () => ({
      json: async () => ({ dist: {} }),
      ok: true,
      status: 200,
    })),
    /missing dist\.integrity/u,
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
