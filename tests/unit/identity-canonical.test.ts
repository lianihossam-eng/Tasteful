import { rejectsWithCode, throwsWithCode } from "../assert-code.js";
/** Owner/approver canonical identity: normalization, schema rejection, self-approval matrix. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { canonicalIdentity, sameIdentity } from "../../src/design/identity.js";
import { computeGateContentHash } from "../../src/design/hashes.js";
import { validateDecision, validateGate } from "../../src/design/schema.js";
import { initProject, type ProjectPaths } from "../../src/design/store.js";
import {
  checkAcceptApproval,
  checkGateApproval,
  grantAcceptApproval,
  grantGateApproval,
} from "../../src/host/tools.js";
import { operationDigest, paramsHash } from "../../src/host/approvals.js";
import { readJournalEntries } from "../../src/host/journal.js";
import { cmdAccept, cmdApproveGrant } from "../../src/cli/commands.js";
import { decisionBase, tempDir, writeJson } from "../helpers.js";

const HASH = "a".repeat(64);

async function project(prefix = "tasteful-identity-"): Promise<ProjectPaths> {
  return initProject(await tempDir(prefix), "identity", "0.1.0");
}

function gateBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gate_id: "G-DESIGN-REVIEW",
    stage: "visual-system",
    checklist: [
      {
        criterion: "contrast AA",
        evidence_ref: "artifacts/contrast.json",
        verifier_role: "accessibility",
        verdict: "pass",
        date: "2026-11-11",
      },
    ],
    decision: "pending",
    approver: "lead@example",
    owner: "designer@example",
    waivers: [],
    ...overrides,
  };
}

test("canonicalIdentity: NFKC + trim; emails lowercase the domain only", () => {
  assert.equal(canonicalIdentity(" Lead@EXAMPLE.com "), "Lead@example.com");
  assert.equal(canonicalIdentity("User@EXAMPLE.com"), "User@example.com");
  assert.equal(canonicalIdentity("  plain-role  "), "plain-role");
  assert.equal(canonicalIdentity("Lead Operator"), "lead operator");
  // NFKC: e + combining acute and precomposed é compare the same.
  assert.equal(canonicalIdentity("cafe\u0301@example.com"), canonicalIdentity("caf\u00e9@example.com"));
});

test("canonicalIdentity: empty or blank identity rejected (E_SCHEMA)", () => {
  throwsWithCode(() => canonicalIdentity(""), "E_SCHEMA");
  throwsWithCode(() => canonicalIdentity("   "), "E_SCHEMA");
  throwsWithCode(() => canonicalIdentity("\n\t "), "E_SCHEMA");
});

test("sameIdentity: domain/display case-insensitive, local part case-sensitive", () => {
  assert.equal(sameIdentity("User@EXAMPLE.com", "User@example.com"), true);
  assert.equal(sameIdentity("  User@example.com  ", "User@example.com"), true);
  assert.equal(sameIdentity("Lead Operator", " lead operator "), true);
  assert.equal(sameIdentity("cafe\u0301@example.com", "caf\u00e9@example.com"), true);
  assert.equal(sameIdentity("User@x", "user@x"), false, "email local part is case-sensitive");
  assert.equal(sameIdentity("", "anything"), false);
  assert.equal(sameIdentity("   ", "anything"), false);
});

test("authored owner/approver whitespace and blank identities are schema-rejected, never rewritten", () => {
  throwsWithCode(() => validateDecision({ ...decisionBase("D001"), owner: "owner " }), "E_SCHEMA");
  throwsWithCode(() => validateDecision({ ...decisionBase("D001"), owner: " owner" }), "E_SCHEMA");
  throwsWithCode(() => validateDecision({ ...decisionBase("D001"), owner: "   " }), "E_SCHEMA");
  throwsWithCode(() => validateGate(gateBase({ owner: "designer@example " })), "E_SCHEMA");
  throwsWithCode(() => validateGate(gateBase({ approver: " lead@example" })), "E_SCHEMA");
  throwsWithCode(
    () =>
      validateGate(
        gateBase({
          waivers: [{ criterion: "contrast AA", owner: " lead@example", expiry: "2026-12-01", rationale: "temp" }],
        }),
      ),
    "E_SCHEMA",
  );
  // Internal whitespace is a display id and is preserved verbatim.
  const g = validateGate(gateBase({ owner: "Lead Operator", approver: "designer@example" }));
  assert.equal(g.owner, "Lead Operator");
  assert.equal(g.approver, "designer@example");
});

test("decision accept grant: whitespace/domain-case/unicode variants cannot self-approve", async () => {
  const p = await project();
  for (const [owner, approver] of [
    ["owner", "owner "],
    ["owner", " owner"],
    ["User@example.com", "User@EXAMPLE.com"],
    ["cafe\u0301@example.com", "caf\u00e9@example.com"],
  ] as const) {
    await rejectsWithCode(
      grantAcceptApproval(p, { decision_id: "D001", owner, approver, contentHash: HASH }),
      "E_SELF_APPROVAL",
    );
  }
});

test("decision accept grant: local-part case difference is a different identity (allowed)", async () => {
  const p = await project();
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: "User@x",
    approver: "user@x",
    contentHash: HASH,
  });
  assert.match(digest, /^[0-9a-f]{64}$/);
  const raw = JSON.parse(await fs.readFile(path.join(p.approvals, `${digest.slice(0, 32)}.json`), "utf8")) as {
    approver: string;
    params_hash: string;
  };
  assert.equal(raw.approver, "user@x");
  assert.equal(raw.params_hash, paramsHash({ approver: "user@x" }));
});

test("decision accept grant: empty/whitespace-only approver rejected", async () => {
  const p = await project();
  await rejectsWithCode(
    grantAcceptApproval(p, { decision_id: "D001", owner: "owner", approver: "", contentHash: HASH }),
    "E_APPROVAL_DENIED",
  );
  await rejectsWithCode(
    grantAcceptApproval(p, { decision_id: "D001", owner: "owner", approver: "   ", contentHash: HASH }),
    "E_SCHEMA",
  );
});

test("decision accept grant: normal non-owner approver is stored canonically", async () => {
  const p = await project();
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: "designer@example",
    approver: " Lead@EXAMPLE.com ",
    contentHash: HASH,
  });
  const raw = JSON.parse(await fs.readFile(path.join(p.approvals, `${digest.slice(0, 32)}.json`), "utf8")) as {
    approver: string;
    params_hash: string;
  };
  assert.equal(raw.approver, "Lead@example.com");
  assert.equal(raw.params_hash, paramsHash({ approver: "Lead@example.com" }));
});

test("gate accept grant: same canonical self-approval matrix", async () => {
  const p = await project();
  for (const [owner, approver] of [
    ["owner", "owner "],
    ["owner", " owner"],
    ["User@example.com", "User@EXAMPLE.com"],
    ["cafe\u0301@example.com", "caf\u00e9@example.com"],
  ] as const) {
    await rejectsWithCode(
      grantGateApproval(p, { gate_id: "G-DESIGN-REVIEW", owner, approver, contentHash: HASH }),
      "E_SELF_APPROVAL",
    );
  }
  const { digest } = await grantGateApproval(p, {
    gate_id: "G-DESIGN-REVIEW",
    owner: "User@x",
    approver: "user@x",
    contentHash: HASH,
  });
  const raw = JSON.parse(await fs.readFile(path.join(p.approvals, `${digest.slice(0, 32)}.json`), "utf8")) as {
    approver: string;
  };
  assert.equal(raw.approver, "user@x");
  await rejectsWithCode(
    grantGateApproval(p, { gate_id: "G-DESIGN-REVIEW", owner: "owner", approver: "  ", contentHash: HASH }),
    "E_SCHEMA",
  );
});

test("CLI accept normalizes --approver before granting and journaling", async () => {
  const dir = await tempDir("tasteful-identity-cli-");
  const p = await initProject(dir, "identity", "0.1.0");
  const file = path.join(dir, "D001.json");
  await writeJson(file, decisionBase("D001"));
  const digest = (await cmdAccept({ project: dir }, { file }, " Lead@EXAMPLE.com ")).trim();
  const raw = JSON.parse(await fs.readFile(path.join(p.approvals, `${digest.slice(0, 32)}.json`), "utf8")) as {
    approver: string;
    params_hash: string;
  };
  assert.equal(raw.approver, "Lead@example.com");
  assert.equal(raw.params_hash, paramsHash({ approver: "Lead@example.com" }));
  const journal = await readJournalEntries(p);
  const granted = journal.find((e) => e.kind === "approval" && e.payload.tool === "decision_accept");
  assert.equal(granted?.payload.approver, "Lead@example.com");
});

test("CLI approve --grant normalizes --approver before granting", async () => {
  const dir = await tempDir("tasteful-identity-cli-");
  const p = await initProject(dir, "identity", "0.1.0");
  const digest = (
    await cmdApproveGrant(
      { project: dir },
      { tool: "fs_write", target: "/t/f.txt", content: "hello", params: { path: "f.txt" }, approver: " Op@TASTEFUL " },
    )
  ).trim();
  const raw = JSON.parse(await fs.readFile(path.join(p.approvals, `${digest.slice(0, 32)}.json`), "utf8")) as {
    approver: string;
  };
  assert.equal(raw.approver, "Op@tasteful");
});

function contentBoundRecord(tool: string, target: string, contentHash: string, approver: string): Record<string, unknown> {
  const params = { approver };
  const digest = operationDigest({ tool, target, content: contentHash, params });
  return {
    digest,
    tool,
    target,
    content_hash: contentHash,
    params_hash: paramsHash(params),
    approver,
    created_at: "2026-11-11T00:00:00.000Z",
    used: false,
    decision: "granted",
  };
}

test("decision accept check rejects a hand-written self-approval record canonically", async () => {
  const p = await project();
  const record = contentBoundRecord("decision_accept", "D001", HASH, " owner ");
  const digest = record.digest as string;
  await writeJson(path.join(p.approvals, `${digest.slice(0, 32)}.json`), record);
  await rejectsWithCode(checkAcceptApproval(p, digest, "owner", "D001", HASH), "E_SELF_APPROVAL");
});

test("gate approval check compares owner and gate approver canonically", async () => {
  const p = await project();
  const gate = validateGate(gateBase());
  const content = computeGateContentHash(gate);

  const matching = contentBoundRecord("gate_accept", gate.gate_id, content, " lead@example ");
  await writeJson(path.join(p.approvals, `${(matching.digest as string).slice(0, 32)}.json`), matching);
  assert.equal(await checkGateApproval(p, matching.digest as string, gate), matching.digest);

  const self = contentBoundRecord("gate_accept", gate.gate_id, content, " designer@example ");
  await writeJson(path.join(p.approvals, `${(self.digest as string).slice(0, 32)}.json`), self);
  await rejectsWithCode(checkGateApproval(p, self.digest as string, gate), "E_SELF_APPROVAL");
});
