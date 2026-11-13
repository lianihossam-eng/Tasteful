#!/usr/bin/env bash
# Operator-runnable CLI end-to-end: temp HOME + temp project, BRIM read-only.
# Every scenario step is a separate `node dist/src/bin.js` process. Exit codes
# and JSON outputs are asserted; any mismatch fails loudly. When the BRIM
# fixture is absent the run is skipped with an explicit reason (exit 0).
set -euo pipefail
cd "$(dirname "$0")/.."

BRIM="${TASTEFUL_BRIM:-}"
if [ -z "$BRIM" ] || [ ! -f "$BRIM" ]; then
  echo "E2E-CLI SKIP: BRIM fixture missing (set TASTEFUL_BRIM)" >&2
  exit 0
fi

ROOT="$(pwd)"
echo "== build =="
npm run build --silent

BASE="$(mktemp -d)"
export TASTEFUL_HOME="$BASE/home"
export HOME="$TASTEFUL_HOME"
mkdir -p "$TASTEFUL_HOME"
PROJ="$BASE/proj"
mkdir -p "$PROJ"
CLI=(node "$ROOT/dist/src/bin.js" --project "$PROJ")
DAY="2026-11-11"
OWNER="designer@example"
LEAD="lead@example"

fail() { echo "E2E FAIL: $*" >&2; exit 1; }

# expect_fail <stderr-regex> <command...>
expect_fail() {
  local pattern="$1"; shift
  local out err rc=0
  out="$(mktemp)"; err="$(mktemp)"
  "$@" >"$out" 2>"$err" || rc=$?
  if [ "$rc" -eq 0 ]; then
    cat "$out" >&2
    rm -f "$out" "$err"
    fail "expected nonzero exit: $*"
  fi
  grep -Eq "$pattern" "$err" || fail "stderr for '$*' does not match $pattern: $(cat "$err")"
  rm -f "$out" "$err"
}

expect_digest() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail "expected 64-hex digest, got: $1"
}

BRIM_HASH_BEFORE="$(sha256sum "$BRIM" | cut -d' ' -f1)"
[ -n "$BRIM_HASH_BEFORE" ] || fail "cannot hash BRIM"

echo "== init =="
INIT_OUT="$("${CLI[@]}" init --name e2e-cli)"
grep -q '\.tasteful' <<<"$INIT_OUT" || fail "init output missing .tasteful"
[ -f "$PROJ/.tasteful/project.json" ] || fail "init did not create project.json"

echo "== brief =="
cat > "$PROJ/brief.md" <<'EOF'
# BRIM Boutique
Mobile checkout first. Desktop 1440, mobile 390.
EOF
cat > "$PROJ/coverage.json" <<'EOF'
{"brief_id":"B-001","platforms":["desktop-1440","mobile-390"],"screens":[
{"screen":"checkout-payment","states":["default","error","loading","empty"],"breakpoints":["mobile-390","desktop-1440"],"decision":"in","rationale":"payment failure is critical"},
{"screen":"marketing-about","states":["default"],"breakpoints":["desktop-1440"],"decision":"out","rationale":"single static page"}]}
EOF
BRIEF_OUT="$("${CLI[@]}" brief --file "$PROJ/brief.md" --coverage "$PROJ/coverage.json")"
grep -q 'B-001' <<<"$BRIEF_OUT" || fail "brief output missing B-001"
BH="$("${CLI[@]}" hash --file .tasteful/brief.md | tr -d '\n')"
[ -n "$BH" ] || fail "brief hash empty"

printf 'nav research: bottom tab bar\n' > "$PROJ/evidence-nav.md"
NH="$(sha256sum "$PROJ/evidence-nav.md" | cut -d' ' -f1)"

echo "== adapter =="
ADAPTER_OUT="$("${CLI[@]}" adapter check --canary "$BRIM")"
grep -q 'cli=0\.14\.0' <<<"$ADAPTER_OUT" || fail "adapter check not pinned: $ADAPTER_OUT"
grep -q 'canary=true' <<<"$ADAPTER_OUT" || fail "adapter canary did not run: $ADAPTER_OUT"
"${CLI[@]}" info --file "$BRIM" > "$BASE/info.json"
STATUS_FILE="$BASE/info.json" node --input-type=module -e '
import { readFileSync } from "node:fs";
const info = JSON.parse(readFileSync(process.env.STATUS_FILE, "utf8"));
if (info.nodes !== 1080) { console.error(`nodes=${info.nodes}`); process.exit(1); }
if (!(info.pages?.[0]?.frames?.length >= 30)) { console.error("frames missing"); process.exit(1); }
'

echo "== export =="
EXPORT_OUT="$("${CLI[@]}" export --file "$BRIM" --out .tasteful/exports/accueil.png --node "01 — Accueil · Desktop" --format png)"
EXPORT_LINE="$(sed -n '1p' <<<"$EXPORT_OUT")"
EH="${EXPORT_LINE##* }"
expect_digest "$EH"
ACTUAL_EH="$(sha256sum "$PROJ/.tasteful/exports/accueil.png" | cut -d' ' -f1)"
[ "$EH" = "$ACTUAL_EH" ] || fail "export hash mismatch: output=$EH actual=$ACTUAL_EH"

echo "== decisions D001-D007 =="
PROJ="$PROJ" DAY="$DAY" EH="$EH" BH="$BH" NH="$NH" node --input-type=module <<'NODE'
import { writeFile } from "node:fs/promises";
const { PROJ, DAY, EH, BH, NH } = process.env;
const base = (id, extra = {}) => ({
  schema_version: 1, id, version: 1, title: `T ${id}`, question: "Q?",
  status: "proposed", owner: "designer@example", created_at: DAY, updated_at: DAY,
  claims: [], depends_on: [], evidence: [], alternatives: [], artifacts: [], ...extra,
});
const claim = [{ claim_id: "C-PLATFORM-MOBILE", subject: "platform.mobile", predicate: "is", value: "mobile-web", scope: "project" }];
const evidence = [{ type: "brief", ref: ".tasteful/brief.md", sha256: BH, captured_at: DAY }];
const research = [{ type: "research", ref: "evidence-nav.md", sha256: NH, captured_at: DAY }];
const artifact = [{ path: ".tasteful/exports/accueil.png", sha256: EH, validator_version: 1, validated_at: DAY, checks: ["opens"], ready: true }];
const ds = {
  D001: base("D001", { title: "Platform scope", claims: claim, evidence, artifacts: artifact }),
  D002: base("D002", { title: "Mobile navigation", claims: claim, depends_on: ["D001"], evidence: research, artifacts: artifact }),
  D003: base("D003", { title: "Checkout flow", depends_on: ["D002"] }),
  D004: base("D004", { title: "About page" }),
  D005: base("D005", { title: "Design tokens", depends_on: ["D002"] }),
  D006: base("D006", { title: "Design review acceptance", gate_ref: "G-DESIGN-REVIEW", depends_on: ["D003", "D005"], evidence, artifacts: artifact }),
  D007: base("D007", { title: "Handoff checklist", gate_ref: "G-DESIGN-REVIEW", depends_on: ["D004"], evidence: research, artifacts: artifact }),
};
for (const [id, d] of Object.entries(ds)) await writeFile(`${PROJ}/${id}.json`, JSON.stringify(d));
NODE
for id in D001 D002 D003 D004 D005 D006 D007; do
  OUT="$("${CLI[@]}" decision create --file "$PROJ/$id.json")"
  grep -Eq "^${id} v[0-9]+ [0-9a-f]{64}" <<<"$OUT" || fail "decision create $id output: $OUT"
done

echo "== gate (self-approval + missing evidence leave no file; valid passes) =="
cat > "$PROJ/gate.json" <<'EOF'
{"gate_id":"G-BAD","stage":"visual-system","checklist":[{"criterion":"contrast AA","evidence_ref":"artifacts/contrast.json","verifier_role":"accessibility","verdict":"pass","date":"2026-11-11"}],"decision":"pass","approver":"designer@example","owner":"designer@example","waivers":[]}
EOF
expect_fail 'E_SELF_APPROVAL' "${CLI[@]}" gate create --file "$PROJ/gate.json"
[ ! -e "$PROJ/.tasteful/gates/G-BAD.json" ] || fail "rejected self-approved gate was persisted"
cat > "$PROJ/gate.json" <<'EOF'
{"gate_id":"G-BAD","stage":"visual-system","checklist":[{"criterion":"contrast AA","evidence_ref":"","verifier_role":"accessibility","verdict":"pass","date":"2026-11-11"}],"decision":"pass","approver":"lead@example","owner":"designer@example","waivers":[]}
EOF
expect_fail 'E_GATE_BLOCKED|E_SCHEMA' "${CLI[@]}" gate create --file "$PROJ/gate.json"
[ ! -e "$PROJ/.tasteful/gates/G-BAD.json" ] || fail "rejected gate was persisted"
cat > "$PROJ/gate.json" <<'EOF'
{"gate_id":"G-DESIGN-REVIEW","stage":"visual-system","checklist":[{"criterion":"contrast AA","evidence_ref":"artifacts/contrast.json","verifier_role":"accessibility","verdict":"pass","date":"2026-11-11"}],"decision":"pass","approver":"lead@example","owner":"designer@example","waivers":[]}
EOF
GATE_AID="$("${CLI[@]}" gate accept --file "$PROJ/gate.json" --approver "$LEAD" | tr -d '\n')"
expect_digest "$GATE_AID"
GATE_OUT="$("${CLI[@]}" gate create --file "$PROJ/gate.json" --approval "$GATE_AID")"
grep -qx 'G-DESIGN-REVIEW' <<<"$GATE_OUT" || fail "gate create output: $GATE_OUT"

echo "== validate artifacts (fresh record required before accept) =="
for id in D006 D007; do
  VALIDATE_OUT="$("${CLI[@]}" validate --decision "$id" --artifact .tasteful/exports/accueil.png)"
  grep -Eq '^OK ' <<<"$VALIDATE_OUT" || fail "validate $id: $VALIDATE_OUT"
done
[ -n "$(find "$PROJ/.tasteful/validations" -name 'D006-*.json' -print -quit)" ] || fail "D006 validation record missing"
[ -n "$(find "$PROJ/.tasteful/validations" -name 'D007-*.json' -print -quit)" ] || fail "D007 validation record missing"

echo "== accept D006 + D007 (no approval rejected, digest, replay denied) =="
PROJ="$PROJ" DAY="$DAY" EH="$EH" BH="$BH" NH="$NH" node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const { PROJ } = process.env;
// Acceptance reads the authored record: rebuild it from the stored decision
// after artifact_validate refreshed validated_at/checks/ready, then set the
// human-accepted status. review_state/decision_hash are derived and rejected
// on authored input.
for (const id of ["D006", "D007"]) {
  const stored = JSON.parse(await readFile(`${PROJ}/.tasteful/decisions/${id}.json`, "utf8"));
  delete stored.review_state;
  delete stored.decision_hash;
  stored.status = "accepted";
  await writeFile(`${PROJ}/${id}.json`, JSON.stringify(stored));
}
NODE
expect_fail 'E_ACCEPT_NO_APPROVAL' "${CLI[@]}" decision create --file "$PROJ/D006.json"
AID6="$("${CLI[@]}" accept --file "$PROJ/D006.json" --approver "$LEAD" | tr -d '\n')"
expect_digest "$AID6"
ACCEPT_OUT="$("${CLI[@]}" decision create --file "$PROJ/D006.json" --approval "$AID6")"
grep -Eq '^D006 v[0-9]+ ' <<<"$ACCEPT_OUT" || fail "accepted D006 output: $ACCEPT_OUT"
expect_fail 'E_APPROVAL_REPLAY|E_APPROVAL_MUTATED|E_APPROVAL_DENIED|E_ACCEPT_NO_APPROVAL' \
  "${CLI[@]}" decision create --file "$PROJ/D006.json" --approval "$AID6"
AID7="$("${CLI[@]}" accept --file "$PROJ/D007.json" --approver "$LEAD" | tr -d '\n')"
expect_digest "$AID7"
[ "$AID6" != "$AID7" ] || fail "approvals for D006 and D007 must differ"
ACCEPT7_OUT="$("${CLI[@]}" decision create --file "$PROJ/D007.json" --approval "$AID7")"
grep -Eq '^D007 v[0-9]+ ' <<<"$ACCEPT7_OUT" || fail "accepted D007 output: $ACCEPT7_OUT"

echo "== approve --grant / --deny round-trip (fs_write) =="
FS_TARGET="$PROJ/evidence-nav.md"
GRANT_ARGS=(approve --grant --tool fs_write --target "$FS_TARGET" --content "nav research: bottom tab bar" --params-json '{"path":"evidence-nav.md"}' --approver "$OWNER")
GID="$("${CLI[@]}" "${GRANT_ARGS[@]}" | tr -d '\n')"
expect_digest "$GID"
LIST_OUT="$("${CLI[@]}" approve --list)"
grep -q "${GID:0:16}" <<<"$LIST_OUT" || fail "approve --list missing granted digest: $LIST_OUT"
DID="$("${CLI[@]}" approve --deny --tool fs_write --target "$FS_TARGET" --content "nav research: bottom tab bar" --params-json '{"path":"evidence-nav.md"}' --approver "$OWNER" | tr -d '\n')"
expect_digest "$DID"
[ "$GID" = "$DID" ] || fail "deny digest $DID != grant digest $GID"
"${CLI[@]}" approve --list | grep -q 'no pending approvals' || fail "denied grant still pending"
expect_fail 'E_USAGE' "${CLI[@]}" approve --grant

echo "== invalidate: exact closure =="
INV_OUT="$("${CLI[@]}" invalidate --claim C-PLATFORM-MOBILE --old mobile-web --new mobile-web+ios --reason "sponsor adds a native iOS app" --author "$OWNER")"
grep -Eq '^E-[A-Za-z0-9-]+' <<<"$INV_OUT" || fail "invalidate output missing event id: $INV_OUT"
grep -qx 'D001 stale' <<<"$INV_OUT" || fail "closure missing D001 stale"
grep -qx 'D002 stale' <<<"$INV_OUT" || fail "closure missing D002 stale"
grep -qx 'D003 needs_review' <<<"$INV_OUT" || fail "closure missing D003 needs_review"
grep -qx 'D005 needs_review' <<<"$INV_OUT" || fail "closure missing D005 needs_review"
grep -qx 'D006 invalidated' <<<"$INV_OUT" || fail "closure missing D006 invalidated"
! grep -q '^D004 ' <<<"$INV_OUT" || fail "D004 must stay outside the closure"
! grep -q '^D007 ' <<<"$INV_OUT" || fail "D007 must stay outside the closure"
"${CLI[@]}" status --json > "$BASE/status-closure.json"
STATUS_FILE="$BASE/status-closure.json" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.STATUS_FILE, "utf8"));
const by = Object.fromEntries(s.decisions.map((d) => [d.id, d]));
const want = { D001: "stale", D002: "stale", D003: "needs_review", D004: "current", D005: "needs_review", D006: "invalidated", D007: "current" };
if (s.decisions.length !== 7) { console.error(`decisions=${s.decisions.length}`); process.exit(1); }
for (const [id, state] of Object.entries(want)) {
  if (by[id]?.review_state !== state) { console.error(`${id}: ${by[id]?.review_state} != ${state}`); process.exit(1); }
}
if (by.D007.status !== "accepted") { console.error("D007 must stay accepted outside closure"); process.exit(1); }
for (const id of ["D001", "D002", "D006"]) {
  if (!by[id].artifacts.length || by[id].artifacts.some((a) => a.ready !== false)) {
    console.error(`${id}: artifacts must be ready:false`); process.exit(1);
  }
}
if (by.D007.artifacts.some((a) => a.ready !== true)) { console.error("D007 artifact must stay ready"); process.exit(1); }
if (s.journal_ok !== true) { console.error(`journal_ok=${s.journal_ok}`); process.exit(1); }
NODE

echo "== drift: current decision D007 =="
printf '\0' >> "$PROJ/.tasteful/exports/accueil.png"
DRIFT_OUT="$("${CLI[@]}" validate --decision D007 --artifact .tasteful/exports/accueil.png)"
grep -Eq '^DRIFT ' <<<"$DRIFT_OUT" || fail "validate did not report DRIFT: $DRIFT_OUT"
"${CLI[@]}" status --json > "$BASE/status-drift.json"
STATUS_FILE="$BASE/status-drift.json" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.STATUS_FILE, "utf8"));
const by = Object.fromEntries(s.decisions.map((d) => [d.id, d]));
if (by.D007.review_state !== "needs_review") { console.error(`D007 state=${by.D007.review_state}`); process.exit(1); }
if (by.D007.status !== "proposed") { console.error(`D007 status=${by.D007.status}`); process.exit(1); }
if (by.D007.artifacts.some((a) => a.ready !== false)) { console.error("D007 artifact still ready"); process.exit(1); }
if (by.D004.review_state !== "current") { console.error("D004 must stay current"); process.exit(1); }
NODE

echo "== run (deterministic agent wiring smoke) =="
RUN_OUT="$("${CLI[@]}" run --prompt "Check decision D007 and the journal." --model mock)"
grep -q 'tools: run_journal_read' <<<"$RUN_OUT" || fail "run output missing tool call: $RUN_OUT"
grep -q 'last: run complete' <<<"$RUN_OUT" || fail "run output missing final text: $RUN_OUT"

echo "== status =="
"${CLI[@]}" status --json > "$BASE/status-final.json"
STATUS_FILE="$BASE/status-final.json" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.STATUS_FILE, "utf8"));
if (s.decisions.length !== 7) { console.error(`decisions=${s.decisions.length}`); process.exit(1); }
if (s.journal_ok !== true) { console.error(`journal_ok=${s.journal_ok} error=${s.journal_error ?? ""}`); process.exit(1); }
if (!(s.journal_seq > 10)) { console.error(`journal_seq=${s.journal_seq}`); process.exit(1); }
const by = Object.fromEntries(s.decisions.map((d) => [d.id, d]));
if (by.D006.review_state !== "invalidated") { console.error(`D006=${by.D006.review_state}`); process.exit(1); }
if (by.D007.review_state !== "needs_review") { console.error(`D007=${by.D007.review_state}`); process.exit(1); }
if (!s.gates.some((g) => g.gate_id === "G-DESIGN-REVIEW" && g.decision === "pass")) {
  console.error("gate missing from status"); process.exit(1);
}
NODE

echo "== identity + BRIM integrity =="
VERSION_OUT="$("${CLI[@]}" --version)"
grep -Eq '^tasteful [0-9]+\.[0-9]+\.[0-9]+' <<<"$VERSION_OUT" || fail "--version: $VERSION_OUT"
HELP_OUT="$("${CLI[@]}" --help)"
! grep -Eqi 'pi\.dev|earendil' <<<"$HELP_OUT" || fail "--help leaks pi branding"
BRIM_HASH_AFTER="$(sha256sum "$BRIM" | cut -d' ' -f1)"
[ "$BRIM_HASH_BEFORE" = "$BRIM_HASH_AFTER" ] || fail "BRIM changed: $BRIM_HASH_BEFORE -> $BRIM_HASH_AFTER"

echo "E2E-CLI OK  proj=$PROJ home=$TASTEFUL_HOME brim_sha256=$BRIM_HASH_AFTER"
