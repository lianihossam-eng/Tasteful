/**
 * Change-event ids: max numeric suffix + 1 per day, never a file count, so a
 * gap in existing events can never make the next event overwrite one.
 */
import { rejectsWithCode } from "../assert-code.js";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initProject, writeEvent } from "../../src/design/store.js";
import { decisionInvalidate, decisionUpsert, makeToolContext } from "../../src/host/tools.js";
import { decisionBase, tempDir } from "../helpers.js";

const CLAIM = {
  claim_id: "C-PLATFORM-MOBILE",
  subject: "platform.mobile",
  predicate: "is",
  value: "mobile-web",
  scope: "project",
};

function ctxFor(root: string) {
  return makeToolContext(root, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, "human");
}

async function setup() {
  const dir = await tempDir("tasteful-event-id-");
  const p = await initProject(dir, "event-id", "0.1.0");
  await decisionUpsert(ctxFor(dir), {
    decision: decisionBase("D0001", { claims: [CLAIM] }),
  });
  return { dir, p, day: new Date().toISOString().slice(0, 10) };
}

function invalidate(dir: string) {
  return decisionInvalidate(ctxFor(dir), {
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    reason: "scope change",
    author: "designer@example",
  });
}

test("event id skips a suffix gap and never overwrites an existing event", async () => {
  const { dir, p, day } = await setup();
  const first = path.join(p.events, `E-${day}-001.json`);
  const third = path.join(p.events, `E-${day}-003.json`);
  await fs.writeFile(first, '{"marker":"first-untouched"}\n', "utf8");
  await fs.writeFile(third, '{"marker":"third-untouched"}\n', "utf8");

  const res = await invalidate(dir);
  assert.equal(res.event_id, `E-${day}-004`);
  assert.equal(await fs.readFile(first, "utf8"), '{"marker":"first-untouched"}\n');
  assert.equal(await fs.readFile(third, "utf8"), '{"marker":"third-untouched"}\n');
  const created = JSON.parse(await fs.readFile(path.join(p.events, `E-${day}-004.json`), "utf8")) as {
    event_id: string;
  };
  assert.equal(created.event_id, `E-${day}-004`);
});

test("event ids advance normally one per invalidation", async () => {
  const { dir, p, day } = await setup();
  const one = await invalidate(dir);
  assert.equal(one.event_id, `E-${day}-001`);
  const two = await invalidate(dir);
  assert.equal(two.event_id, `E-${day}-002`);
  assert.deepEqual(
    (await fs.readdir(p.events)).filter((e) => e.endsWith(".json")).sort(),
    [`E-${day}-001.json`, `E-${day}-002.json`],
  );
});

test("writeEvent refuses to overwrite an existing event (E_EVENT_EXISTS)", async () => {
  const { dir, p, day } = await setup();
  const ev = {
    event_id: `E-${day}-009`,
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    source: "scope-change",
    occurred_at: day,
    reason: "scope change",
    author: "designer@example",
  };
  await writeEvent(p, ev);
  await rejectsWithCode(writeEvent(p, ev), "E_EVENT_EXISTS");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(p.events, `E-${day}-009.json`), "utf8")).event_id,
    `E-${day}-009`,
  );
});
