import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

test("maintainer documentation covers setup, domain states, security, adapters, and recovery", () => {
  const readme = read("README.md");
  const operations = read("OPERATIONS.md");
  const skill = read("SKILL.md");
  const projectGuide = read("assets/project-docs/sandcastle-queue.md");
  const corpus = [readme, operations, skill, projectGuide].join("\n");

  assert.match(readme, /Quickstart/u);
  assert.match(readme, /OPERATIONS\.md/u);
  assert.match(corpus, /workflow-host/u);
  assert.match(corpus, /尚未实现/u);

  for (const term of [
    "pending",
    "configure-github",
    "doctor --offline",
    "remote-doctor",
    "Batch",
    "Ticket",
    "Frontier",
    "Continuation Run",
    "Published Commit",
    "Final Review",
    "no-change",
    "abort",
    "credential broker",
    "sandbox network",
    "protected paths",
    "operation permissions",
    "audit",
    "reconciliation",
    "upgrade",
    "adopt",
    "rollback",
    "uninstall",
    "base drift",
    "human fix",
  ]) {
    assert.equal(corpus.includes(term), true, term);
  }

  for (const adapter of [
    "python-pip",
    "python-uv",
    "node-npm",
    "go-module",
    "java-maven",
    "composite",
    "custom",
  ]) {
    assert.equal(operations.includes(adapter), true, adapter);
  }
  for (const section of [
    "queue",
    "runtime",
    "commands",
    "provider",
    "execution",
    "audit",
  ]) {
    assert.equal(operations.includes(`\`${section}\``), true, section);
  }
  assert.doesNotMatch(corpus, /[—–]/u);
});
