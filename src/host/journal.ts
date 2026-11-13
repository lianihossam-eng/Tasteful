/**
 * Run journal: hash-chained append-only JSONL. Host-side writes only;
 * the model gets run_journal_read and nothing else.
 */
import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "../design/hashes.js";
import { type ProjectPaths, listDecisionIds, writeFileAtomic } from "../design/store.js";

export type JournalKind =
  | "command"
  | "tool_call"
  | "approval"
  | "change_event"
  | "adapter"
  | "gate"
  | "error";

export type JournalActor = "human" | "agent" | "system";

export interface JournalEntry {
  seq: number;
  ts: string;
  kind: JournalKind;
  actor: JournalActor;
  payload: Record<string, unknown>;
  payload_hash: string;
  prev_hash: string;
  versions: { tasteful: string; pi: string; figcraft_cli?: string };
  roots?: { project?: string; exports?: string };
  stderr_tail?: string;
}

export interface JournalContext {
  tastefulVersion: string;
  piVersion: string;
  figcraftCli?: string;
  roots?: { project?: string; exports?: string };
}

export class JournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

function journalFile(p: ProjectPaths): string {
  return path.join(p.journal, "run.jsonl");
}

/**
 * The journal leaf must be a regular file: a symlink would let host appends
 * escape the project, and a non-file (directory, fifo, ...) is corruption.
 * A missing leaf is not by itself an error; callers decide what it means.
 */
async function assertJournalLeaf(p: ProjectPaths): Promise<Stats | undefined> {
  let st;
  try {
    st = await fs.lstat(journalFile(p));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new JournalError("E_JOURNAL_LEAF", `journal leaf must not be a symlink: ${journalFile(p)}`);
  }
  if (!st.isFile()) {
    throw new JournalError("E_JOURNAL_LEAF", `journal leaf is not a regular file: ${journalFile(p)}`);
  }
  return st;
}

/** True when the project holds no decisions, gates, or change events. */
async function stateIsEmpty(p: ProjectPaths): Promise<boolean> {
  if ((await listDecisionIds(p)).length > 0) return false;
  for (const dir of [p.gates, p.events]) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (entries.some((e) => e.endsWith(".json"))) return false;
  }
  return true;
}

export async function readJournalEntries(
  p: ProjectPaths,
  opts?: { seq_from?: number; limit?: number },
): Promise<JournalEntry[]> {
  await assertJournalLeaf(p);
  let text: string;
  try {
    text = await fs.readFile(journalFile(p), "utf8");
  } catch (err) {
    // Only a truly absent journal is empty; unreadable state is an error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: JournalEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    // Blank (whitespace-only) lines are tolerated; every other line must be a
    // complete journal entry. Extra fields are allowed: entries are append-only
    // JSONL, so a forward-compatible reader must not reject newer writers'
    // additions (the hash chain only covers seq/ts/kind/payload_hash/prev_hash).
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new JournalError(
        "E_JOURNAL_CORRUPT",
        `journal line ${index + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }
    const isEntry =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "seq" in parsed &&
      typeof parsed.seq === "number" &&
      Number.isInteger(parsed.seq) &&
      parsed.seq >= 1;
    if (!isEntry) {
      throw new JournalError("E_JOURNAL_CORRUPT", `journal line ${index + 1} is not a journal entry`);
    }
    out.push(parsed as JournalEntry);
  }
  const from = opts?.seq_from ?? 1;
  const selected = out.filter((e) => e.seq >= from);
  // No hidden cap: callers that need a window (runJournalRead) clamp their own.
  return opts?.limit === undefined ? selected : selected.slice(0, Math.max(0, opts.limit));
}

/** Verify the hash chain. Returns the entries; throws on any break. */
export async function verifyJournal(p: ProjectPaths): Promise<JournalEntry[]> {
  const leaf = await assertJournalLeaf(p);
  if (leaf === undefined) {
    // A never-written journal is fine only while the project is still empty;
    // once state exists a missing journal means history was dropped.
    if (await stateIsEmpty(p)) return [];
    throw new JournalError("E_JOURNAL_CORRUPT", `journal file missing: ${journalFile(p)}`);
  }
  const entries = await readJournalEntries(p, { seq_from: 1 });
  // An existing-but-empty (zero-byte or whitespace-only) journal on a project
  // that holds state is the same loss as a missing one: the chain cannot be
  // verified, so it is corruption, never a healthy "empty journal".
  if (entries.length === 0 && !(await stateIsEmpty(p))) {
    throw new JournalError("E_JOURNAL_CORRUPT", `journal file is empty: ${journalFile(p)}`);
  }
  let prev = "GENESIS";
  let seq = 1;
  for (const e of entries) {
    if (e.seq !== seq) {
      throw new JournalError("E_JOURNAL_CORRUPT", `journal seq break at seq ${e.seq} (expected ${seq})`);
    }
    if (e.prev_hash !== prev) {
      throw new JournalError("E_JOURNAL_CORRUPT", `journal chain break at seq ${e.seq}`);
    }
    if (e.payload_hash !== sha256Hex(canonicalJson(e.payload))) {
      throw new JournalError("E_JOURNAL_CORRUPT", `journal payload hash mismatch at seq ${e.seq}`);
    }
    prev = entryHash(e);
    seq += 1;
  }
  return entries;
}

function entryHash(e: JournalEntry): string {
  return sha256Hex(canonicalJson({ seq: e.seq, ts: e.ts, kind: e.kind, payload_hash: e.payload_hash, prev_hash: e.prev_hash }));
}

export interface JournalPreflight {
  /**
   * True when the verified journal held no entries because the project itself
   * was empty. The tool's own mutation may then legitimately create the first
   * entry (seq 1): pass this to `appendJournal`'s `fresh_start`.
   */
  freshStart: boolean;
}

/**
 * Fail-closed preflight for state-changing operations. Call this first inside
 * the locked critical section — after the roots check (withLock does it) and
 * before any approval is consumed or state is mutated — so a corrupt, missing,
 * empty-with-state, unreadable, or symlinked journal aborts the operation
 * before it can commit an unjournaled state change.
 */
export async function preflightJournal(p: ProjectPaths): Promise<JournalPreflight> {
  const entries = await verifyJournal(p);
  // verifyJournal only returns an empty list while the project is empty; a
  // later append may therefore be the true first entry of the chain.
  return { freshStart: entries.length === 0 };
}

export async function appendJournal(
  p: ProjectPaths,
  ctx: JournalContext,
  input: { kind: JournalKind; actor: JournalActor; payload: Record<string, unknown>; stderr_tail?: string },
  opts?: {
    /**
     * Internal: granted by `preflightJournal` when the verified journal was
     * empty on an empty project. The current operation's mutation may have
     * made state non-empty before this append; that must still start at seq 1.
     */
    fresh_start?: boolean;
  },
): Promise<JournalEntry> {
  const leaf = await assertJournalLeaf(p);
  await fs.mkdir(p.journal, { recursive: true });
  const existing = await readJournalEntries(p, { seq_from: 1 });
  const freshStart = opts?.fresh_start === true && existing.length === 0;
  // Refuse to restart the chain at seq 1: an empty journal is only legitimate
  // while the project itself is empty, or when preflight proved the project
  // was empty before this operation created its first state. (Preflight runs
  // earlier in every state-changing locked path; this is defense in depth.)
  if (existing.length === 0 && !freshStart && !(await stateIsEmpty(p))) {
    const state = leaf === undefined ? "missing" : "empty";
    throw new JournalError("E_JOURNAL_CORRUPT", `journal file is ${state}: ${journalFile(p)}`);
  }
  // An existing whitespace-only journal on an empty project restarts cleanly:
  // overwrite it so the raw file starts at seq 1 with no blank prefix.
  const startFresh = leaf !== undefined && existing.length === 0;
  const last = existing.length > 0 ? existing[existing.length - 1] : undefined;
  const entry: JournalEntry = {
    seq: last ? last.seq + 1 : 1,
    ts: new Date().toISOString(),
    kind: input.kind,
    actor: input.actor,
    payload: input.payload,
    payload_hash: sha256Hex(canonicalJson(input.payload)),
    prev_hash: last ? entryHash(last) : "GENESIS",
    versions: {
      tasteful: ctx.tastefulVersion,
      pi: ctx.piVersion,
      ...(ctx.figcraftCli ? { figcraft_cli: ctx.figcraftCli } : {}),
    },
    ...(ctx.roots ? { roots: ctx.roots } : {}),
    ...(input.stderr_tail ? { stderr_tail: input.stderr_tail.slice(-4096) } : {}),
  };
  // Re-check under the caller-held project lock: the leaf must not have been
  // swapped for a symlink since the lock was taken.
  await assertJournalLeaf(p);
  const line = canonicalJson(entry) + "\n";
  if (startFresh) await writeFileAtomic(journalFile(p), line);
  else await fs.appendFile(journalFile(p), line, "utf8");
  return entry;
}
