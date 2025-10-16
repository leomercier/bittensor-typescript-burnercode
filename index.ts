// burner-sn121-vote0.js
// Burner script to vote 100% weight to UID=0 on subnet 121.
// Supports Direct setWeights and Commit/Reveal (CRv1), switchable via ENV.
// Auto-runs every 1 minute, persists pending commit state for reveal.
//
// Major update: Hyperparameters are now read from on-chain storage via
//   btApi.query.subtensorModule.* (tempo, commitRevealWeightsEnabled,
//   revealPeriodEpochs, weightsSetRateLimit, weightsVersionKey)
//
// Usage examples:
//   # Auto: try setWeights; if rejected because CR is enabled, do commit→reveal
//   WEIGHTS_MODE=AUTO NETUID=121 TARGET_UID=0 node burner-sn121-vote0.js
//
//   # Force CR mode only (no direct setWeights attempts)
//   WEIGHTS_MODE=CR NETUID=121 TARGET_UID=0 node burner-sn121-vote0.js
//
//   # Force direct setWeights (no CR); will fail on CR-enabled subnets
//   WEIGHTS_MODE=DIRECT NETUID=121 TARGET_UID=0 node burner-sn121-vote0.js
//
// Optional env:
//   RPC_URL=wss://entrypoint-finney.opentensor.ai:443
//   NETUID=121
//   TARGET_UID=0
//   TEST_MODE=true|false
//   STATE_DIR=.burner-state
//   MNEMONIC="seed words here"        // optional; if not set, a burner is generated
//   WEIGHTS_MODE=AUTO|DIRECT|CR       // default AUTO
//   VERSION_KEY=0                     // if set, overrides on-chain/default
//   EPOCH_LENGTH_BLOCKS=101           // fallback if storage fetch fails
//   COMMIT_RATE_LIMIT_BLOCKS=100      // fallback; will be auto-detected from storage
//
// Dependencies (npm):
//   npm i @polkadot/api @polkadot/keyring @polkadot/util-crypto @polkadot/util ws dotenv
//   (or) bun add @polkadot/api @polkadot/keyring @polkadot/util-crypto @polkadot/util ws dotenv
// ───────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { blake2AsHex } from "@polkadot/util-crypto";
import { mnemonicGenerate, cryptoWaitReady } from "@polkadot/util-crypto";
import { webcrypto as nodeCrypto } from "crypto";

// Optional .env loader
try {
  const dotenv = await import("dotenv");
  dotenv?.config?.();
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config / ENV ───────────────────────────────────────────────────────────────
const RPC_URL =
  process.env.RPC_URL || "wss://entrypoint-finney.opentensor.ai:443";
const NETUID = Number(process.env.NETUID ?? 121);
const TARGET_UID = Number(process.env.TARGET_UID ?? 0);
const TEST_MODE = (process.env.TEST_MODE || "false").toLowerCase() === "true";
const INTERVAL_MS = 60_000; // 1 minute
const STATE_DIR = path.resolve(
  process.env.STATE_DIR || path.join(__dirname, ".burner-state")
);

// Mode control via ENV
// WEIGHTS_MODE: 'AUTO' (default), 'DIRECT' (setWeights only), 'CR' (commit/reveal only)
const WEIGHTS_MODE = (process.env.WEIGHTS_MODE || "AUTO").toUpperCase();

// VERSION_KEY: if set, used for both setWeights and CR; otherwise we derive it from chain (weightsVersionKey) or fallback logic.
const ENV_VERSION_KEY =
  process.env.VERSION_KEY !== undefined
    ? Number(process.env.VERSION_KEY)
    : null;

// Fallbacks (will be overwritten by on-chain storage when available)
let EPOCH_LENGTH_BLOCKS = Number(process.env.EPOCH_LENGTH_BLOCKS || 101); // tempo
let COMMIT_REVEAL_EPOCHS = 1; // revealPeriodEpochs
let COMMIT_RATE_LIMIT_BLOCKS = Number(
  process.env.COMMIT_RATE_LIMIT_BLOCKS || 100
);
let DEFAULT_VERSION_KEY = null; // from storage weightsVersionKey

// ── State ─────────────────────────────────────────────────────────────────────
let btApi = null;
let lastHpFetch = 0;
const HP_REFRESH_MS = 5 * 60_000; // refresh hyperparams every 5 minutes

// ── FS utils ──────────────────────────────────────────────────────────────────
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function statePath(name) {
  ensureDir(STATE_DIR);
  return path.join(STATE_DIR, name);
}
function saveJSON(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}
function loadJSON(fp, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return fallback;
  }
}

function metaPath(addr, netuid) {
  const addrSafe = addr.replace(/[^a-zA-Z0-9]/g, "_");
  return statePath(`meta_${addrSafe}_${netuid}.json`);
}
function loadMeta(addr, netuid) {
  return loadJSON(metaPath(addr, netuid), {
    lastCommitBlock: null,
    lastCommitHash: null
  });
}
function saveMeta(addr, netuid, meta) {
  saveJSON(metaPath(addr, netuid), meta);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function randomSalt(len = 32) {
  // Use Vec<u16> salt for CRv1
  const arr = new Uint16Array(len);
  nodeCrypto.getRandomValues(arr);
  return Array.from(arr, (n) => Number(n));
}

// SCALE-encode the tuple (AccountId, u16, Vec<u16>, Vec<u16>, u64, Vec<u16>) and blake2_256
function commitHashFor(
  api,
  { address, netuid, uids, values, versionKey, salt }
) {
  const payload = api.registry
    .createType("(AccountId, u16, Vec<u16>, Vec<u16>, u64, Vec<u16>)", [
      address,
      netuid,
      uids,
      values,
      versionKey,
      salt
    ])
    .toU8a();
  return blake2AsHex(payload, 256);
}

function isCommitRevealError(e) {
  const msg = (e?.code || e?.message || "").toString().toLowerCase();
  // setWeights rejected on CR subnets often returns Custom error: 1
  return (
    msg.includes("commit") ||
    msg.includes("reveal") ||
    /custom error:\s*1\b/.test(msg)
  );
}

function deriveVersionKey(currentBlock) {
  if (ENV_VERSION_KEY !== null) return ENV_VERSION_KEY;
  if (DEFAULT_VERSION_KEY !== null) return DEFAULT_VERSION_KEY; // from on-chain storage
  // Generic fallback for legacy subnets: current block
  return currentBlock;
}

// ── RPC connect ────────────────────────────────────────────────────────────────
async function connectApi() {
  const provider = new WsProvider(RPC_URL);
  const a = await ApiPromise.create({ provider });
  await a.isReady;
  return a;
}

// ── Hyperparams & epoch info (from on-chain storage via query.subtensorModule) ─
// Updates: COMMIT_REVEAL_EPOCHS (revealPeriodEpochs), EPOCH_LENGTH_BLOCKS (tempo),
//          COMMIT_RATE_LIMIT_BLOCKS (weightsSetRateLimit), DEFAULT_VERSION_KEY (weightsVersionKey)
async function fetchHyperparamsAndEpoch() {
  if (!btApi) return;
  const now = Date.now();
  if (now - lastHpFetch < HP_REFRESH_MS) return; // throttle
  lastHpFetch = now;

  try {
    const q = btApi.query.subtensorModule;

    // Parallel storage queries; each returns a Codec-like type.
    const [
      tempoCodec,
      crEnabledCodec,
      revealEpochsCodec,
      rateLimitCodec,
      versionKeyCodec
    ] = await Promise.allSettled([
      q.tempo(NETUID), // epoch length in blocks
      q.commitRevealWeightsEnabled(NETUID), // bool
      q.revealPeriodEpochs(NETUID), // number of epochs between commit and reveal
      q.weightsSetRateLimit(NETUID), // commit/weights set rate limit (blocks)
      q.weightsVersionKey(NETUID) // version key used for weights
    ]);

    // Helper to safely unwrap settled results
    const unwrap = (res) => (res.status === "fulfilled" ? res.value : null);

    const tempo = unwrap(tempoCodec);
    if (tempo) {
      const v = Number(tempo.toString());
      if (Number.isFinite(v) && v > 0) {
        EPOCH_LENGTH_BLOCKS = v;
        console.log(
          `[hp] tempo (epoch length) = ${EPOCH_LENGTH_BLOCKS} blocks`
        );
      }
    }

    const crEnabledVal = unwrap(crEnabledCodec);
    if (crEnabledVal) {
      const enabled = !!(
        crEnabledVal.toJSON?.() ??
        crEnabledVal.toPrimitive?.() ??
        crEnabledVal.isTrue ??
        crEnabledVal
      );
      console.log(`[hp] commitRevealWeightsEnabled = ${enabled}`);
      // (We just log it for visibility; logic is handled by extrinsic outcomes)
    }

    const revealEpochs = unwrap(revealEpochsCodec);
    if (revealEpochs) {
      const v = Number(revealEpochs.toString());
      if (Number.isFinite(v) && v > 0) {
        COMMIT_REVEAL_EPOCHS = v;
        console.log(
          `[hp] revealPeriodEpochs = ${COMMIT_REVEAL_EPOCHS} epoch(s)`
        );
      }
    }

    const rateLimit = unwrap(rateLimitCodec);
    if (rateLimit) {
      const v = Number(rateLimit.toString());
      if (Number.isFinite(v) && v > 0) {
        COMMIT_RATE_LIMIT_BLOCKS = v;
        console.log(
          `[hp] weightsSetRateLimit = ${COMMIT_RATE_LIMIT_BLOCKS} blocks`
        );
      }
    }

    const versionKey = unwrap(versionKeyCodec);
    if (versionKey) {
      const v = Number(versionKey.toString());
      if (Number.isFinite(v)) {
        DEFAULT_VERSION_KEY = v;
        console.log(`[hp] weightsVersionKey = ${DEFAULT_VERSION_KEY}`);
      }
    }
  } catch (e) {
    console.warn(
      "[hp] Failed to fetch hyperparams/epoch via storage; using fallbacks.",
      e?.message || e
    );
  }
}

// ── Low-level send helper with waits ───────────────────────────────────────────
async function sendAndWatch(tx, account, opts = {}) {
  const { waitForInclusion = true, waitForFinalization = false, period } = opts;
  if (TEST_MODE) {
    console.log(
      "[TEST_MODE] Would send:",
      tx.method?.toHex?.() || tx.toString()
    );
    return [true, "TEST_MODE"];
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject([false, "Timeout"]), 120_000);
    tx.signAndSend(
      account,
      { nonce: -1, era: period ? { mortalEra: period } : undefined },
      (result) => {
        const { status, dispatchError } = result;

        if (dispatchError) {
          clearTimeout(timeout);
          let msg = dispatchError.toString();
          if (dispatchError.isModule && btApi) {
            const metaErr = btApi.registry.findMetaError(
              dispatchError.asModule
            );
            msg = `${metaErr.section}.${metaErr.name}`;
          }
          return reject([false, msg]);
        }

        if (waitForInclusion && status?.isInBlock) {
          clearTimeout(timeout);
          return resolve([true, `InBlock ${status.asInBlock.toHex()}`]);
        }
        if (waitForFinalization && status?.isFinalized) {
          clearTimeout(timeout);
          return resolve([true, `Finalized ${status.asFinalized.toHex()}`]);
        }
        if (
          !waitForInclusion &&
          !waitForFinalization &&
          (status?.isInBlock || status?.isFinalized)
        ) {
          clearTimeout(timeout);
          return resolve([true, "Submitted"]);
        }
      }
    ).catch((e) => {
      clearTimeout(timeout);
      reject([false, e?.message || String(e)]);
    });
  });
}

// ── JS equivalents of Python helpers (commit/reveal extrinsics) ───────────────
async function commitWeightsExtrinsic(
  subtensor,
  wallet,
  netuid,
  commitHash,
  opts = {}
) {
  if (!subtensor || !wallet)
    throw new Error("commitWeightsExtrinsic: api/wallet required");
  // @ts-ignore
  const tx = subtensor.tx.subtensorModule.commitWeights(netuid, commitHash);
  try {
    return await sendAndWatch(tx, wallet, opts);
  } catch (res) {
    return res;
  }
}

async function revealWeightsExtrinsic(
  subtensor,
  wallet,
  netuid,
  uids,
  weights,
  salt,
  versionKey,
  opts = {}
) {
  if (!subtensor || !wallet)
    throw new Error("revealWeightsExtrinsic: api/wallet required");
  // @ts-ignore
  const tx = subtensor.tx.subtensorModule.revealWeights(
    netuid,
    uids,
    weights,
    salt,
    versionKey
  );
  try {
    return await sendAndWatch(tx, wallet, opts);
  } catch (res) {
    return res;
  }
}

// Thin wrappers used by the loop
async function commitWeights(account, commitHash) {
  const [ok, msg] = await commitWeightsExtrinsic(
    btApi,
    account,
    NETUID,
    commitHash,
    { waitForInclusion: true }
  );
  if (!ok) throw new Error(msg);
}

async function revealWeights(account, pending) {
  const { uids, values, salt, versionKey } = pending;
  const [ok, msg] = await revealWeightsExtrinsic(
    btApi,
    account,
    NETUID,
    uids,
    values,
    salt,
    versionKey,
    { waitForInclusion: true }
  );
  if (!ok) throw new Error(msg);
}

// ── Direct setWeights path (kept for compatibility) ───────────────────────────
async function submitSetWeights(account, uids, scaled) {
  if (!btApi) throw new Error("API not initialized");
  const header = await btApi.rpc.chain.getHeader();
  const versionKey = deriveVersionKey(header.number.toNumber());

  console.log(
    `[set_weights] netuid=${NETUID} uids=${JSON.stringify(
      uids
    )} weights=${JSON.stringify(scaled)} versionKey=${versionKey}`
  );
  if (TEST_MODE) {
    console.log("[TEST_MODE] Skipping broadcast setWeights.");
    return { ok: true };
  }

  // @ts-ignore
  const tx = btApi.tx.subtensorModule.setWeights(
    NETUID,
    uids,
    scaled,
    versionKey
  );
  try {
    const [ok, msg] = await sendAndWatch(tx, account, {
      waitForInclusion: true
    });
    if (!ok) throw new Error(msg);
    return { ok: true };
  } catch ([ok, msg]) {
    const err = new Error(msg);
    // @ts-ignore
    err.code = msg;
    throw err;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    "Starting burner NETUID=%d TARGET_UID=%d mode=%s (every %ds)",
    NETUID,
    TARGET_UID,
    WEIGHTS_MODE,
    INTERVAL_MS / 1000
  );

  await cryptoWaitReady();
  const mnemonic =
    process.env.MNEMONIC && process.env.MNEMONIC.trim()
      ? process.env.MNEMONIC.trim()
      : mnemonicGenerate();
  const keyring = new Keyring({ type: "sr25519" });
  const account = keyring.addFromUri(mnemonic);
  console.log("Hotkey address:", account.address);
  if (!process.env.MNEMONIC)
    console.log("Ephemeral burner mnemonic:", mnemonic);

  btApi = await connectApi();
  console.log("Connected to node:", RPC_URL);

  let inFlight = false;
  let stop = false;

  const tick = async () => {
    if (stop || inFlight) return;
    inFlight = true;
    try {
      const uids = [TARGET_UID];
      const scaled = [65535]; // 100% to TARGET_UID
      const header = await btApi.rpc.chain.getHeader();
      const currentBlock = header.number.toNumber();
      const versionKey = deriveVersionKey(currentBlock);

      // Refresh on-chain hyperparams (storage) on a throttle
      await fetchHyperparamsAndEpoch();

      // 1) If we have a pending commit, attempt reveal (STRICT EPOCH: commitEpoch + revealPeriodEpochs)
      const addrSafe = account.address.replace(/[^a-zA-Z0-9]/g, "_");
      const pendingPath = statePath(`pending_${addrSafe}_${NETUID}.json`);
      let pending = loadJSON(pendingPath, null);

      if (
        (WEIGHTS_MODE === "CR" || WEIGHTS_MODE === "AUTO") &&
        pending &&
        pending.versionKey !== undefined
      ) {
        // Self-heal legacy/mismatched pending files
        if (pending.commitBlock == null) {
          pending.commitBlock = currentBlock;
          saveJSON(pendingPath, pending);
          console.log(
            "[tick] Migrated pending file: set commitBlock=%d",
            currentBlock
          );
          inFlight = false;
          return;
        }
        const expectedVK = deriveVersionKey(pending.commitBlock);
        if (pending.versionKey !== expectedVK) {
          console.warn(
            `[tick] Pending versionKey=${pending.versionKey} != expected ${expectedVK}; re-committing.`
          );
          try {
            fs.unlinkSync(pendingPath);
          } catch {}
          pending = null;
        }
      }

      if (
        (WEIGHTS_MODE === "CR" || WEIGHTS_MODE === "AUTO") &&
        pending &&
        pending.versionKey !== undefined
      ) {
        // Compute strict reveal epoch window
        const epochLen = EPOCH_LENGTH_BLOCKS;
        const commitEpoch = Math.floor(pending.commitBlock / epochLen);
        const currentEpoch = Math.floor(currentBlock / epochLen);
        const revealEpoch = commitEpoch + (COMMIT_REVEAL_EPOCHS || 1);

        if (currentEpoch < revealEpoch) {
          const blocksSinceCommit = currentBlock - pending.commitBlock;
          const requiredBlocks =
            revealEpoch * epochLen - commitEpoch * epochLen;
          console.log(
            `[tick] Waiting for reveal epoch: ${blocksSinceCommit}/${requiredBlocks} blocks since commit`
          );
          inFlight = false;
          return;
        }

        if (currentEpoch > revealEpoch) {
          // Missed window — re-commit
          console.warn(
            "[tick] Missed reveal window; re-committing fresh payload."
          );
          try {
            fs.unlinkSync(pendingPath);
          } catch {}
        } else {
          // currentEpoch === revealEpoch => reveal now
          try {
            // DEBUG ECHO: recompute expected commit hash from pending before reveal
            const debugRecomputedHash = commitHashFor(btApi, {
              address: account.address,
              netuid: NETUID,
              uids: pending.uids,
              values: pending.values,
              versionKey: pending.versionKey,
              salt: pending.salt
            });
            console.log(
              "[reveal:debug]",
              JSON.stringify(
                {
                  address: account.address,
                  netuid: NETUID,
                  uids: pending.uids,
                  values: pending.values,
                  versionKey: String(pending.versionKey),
                  salt_u16_len: pending.salt?.length ?? 0,
                  recomputedCommitHash: debugRecomputedHash,
                  pendingCommitHash: pending.commitHash || null
                },
                null,
                2
              )
            );

            console.log(
              "[tick] Reveal window open (epoch %d); attempting reveal with versionKey=%s ...",
              currentEpoch,
              String(pending.versionKey)
            );
            await revealWeights(account, pending);
            fs.unlinkSync(pendingPath);
            console.log("[tick] Reveal success.");
            inFlight = false;
            return;
          } catch (e) {
            const raw = String(e?.code || e?.message || e || "");
            if (
              /Custom error:\s*16/i.test(raw) ||
              /CommitNotFound/i.test(raw)
            ) {
              console.warn(
                "[tick] Reveal failed: CommitNotFound. Re-committing."
              );
              try {
                fs.unlinkSync(pendingPath);
              } catch {}
            } else if (
              /Custom error:\s*17/i.test(raw) ||
              /InvalidRevealRound|CommitBlockNotInRevealRange/i.test(raw)
            ) {
              console.log("[tick] Not in reveal round; retry next tick.");
              inFlight = false;
              return;
            } else {
              console.warn("[tick] Reveal failed; will retry later:", raw);
              inFlight = false;
              return;
            }
          }
        }
      }

      // 2) Try direct setWeights if mode allows
      if (WEIGHTS_MODE === "DIRECT" || WEIGHTS_MODE === "AUTO") {
        try {
          await submitSetWeights(account, uids, scaled);
          console.log("[tick] setWeights success.");
          inFlight = false;
          return;
        } catch (e) {
          if (WEIGHTS_MODE === "DIRECT") {
            console.warn(
              "[tick] setWeights failed (DIRECT mode):",
              e.message || e
            );
            inFlight = false;
            return;
          }
          if (!isCommitRevealError(e)) {
            console.warn(
              "[tick] setWeights failed (non-CR error), continuing:",
              e.message || e
            );
            inFlight = false;
            return;
          }
          console.log("[tick] setWeights rejected; switching to CR path.");
        }
      }

      // 3) Commit for later reveal (CR mode or AUTO fallback)
      if (WEIGHTS_MODE === "CR" || WEIGHTS_MODE === "AUTO") {
        // If we still have a valid pending, don't create a new commit.
        const stillPending = loadJSON(pendingPath, null);
        if (stillPending && stillPending.versionKey !== undefined) {
          console.log(
            "[tick] Pending commit already exists — skipping new commit."
          );
          inFlight = false;
          return;
        }

        // Respect commit rate limit (cooldown) based on last successful commit
        const meta = loadMeta(account.address, NETUID);
        if (meta.lastCommitBlock != null) {
          const since = currentBlock - meta.lastCommitBlock;
          if (since < COMMIT_RATE_LIMIT_BLOCKS) {
            console.log(
              `[tick] Commit cooldown: ${since}/${COMMIT_RATE_LIMIT_BLOCKS} blocks since last commit — skipping commit this tick.`
            );
            inFlight = false;
            return;
          }
        }

        const values = scaled; // u16 weights
        const salt = randomSalt(32); // Vec<u16>
        const commitHash = commitHashFor(btApi, {
          address: account.address,
          netuid: NETUID,
          uids,
          values,
          versionKey,
          salt
        });

        // DEBUG ECHO: show exact commit tuple used for hashing
        console.log(
          "[commit:debug]",
          JSON.stringify(
            {
              address: account.address,
              netuid: NETUID,
              uids,
              values,
              versionKey: String(versionKey),
              salt_u16_len: salt.length,
              commitHash
            },
            null,
            2
          )
        );

        try {
          await commitWeights(account, commitHash);
          saveJSON(pendingPath, {
            uids,
            values,
            salt,
            versionKey,
            commitBlock: currentBlock,
            commitHash // keep for reveal debug
          });
          // store last successful commit for rate-limit enforcement
          saveMeta(account.address, NETUID, {
            lastCommitBlock: currentBlock,
            lastCommitHash: commitHash
          });
          console.log("[tick] Commit success; pending reveal stored.");
        } catch (e) {
          const msg = String(e?.message || e);
          if (/CommittingWeightsTooFast/i.test(msg)) {
            const meta2 = loadMeta(account.address, NETUID);
            if (meta2.lastCommitBlock != null) {
              const since = currentBlock - meta2.lastCommitBlock;
              const remain = Math.max(COMMIT_RATE_LIMIT_BLOCKS - since, 0);
              console.warn(
                `[tick] Commit rejected: CommittingWeightsTooFast — wait ~${remain} blocks.`
              );
            } else {
              console.warn(
                "[tick] Commit rejected: CommittingWeightsTooFast — a recent commit exists on-chain."
              );
            }
          } else {
            console.warn("[tick] Commit failed:", msg);
          }
        }
      } else {
        console.log(
          "[tick] CR path disabled by WEIGHTS_MODE; skipping commit."
        );
      }
    } catch (err) {
      console.error("[tick] Unexpected error:", err);
      try {
        await btApi?.rpc.chain.getHeader();
      } catch {
        console.log("[loop] RPC down; reconnecting...");
        try {
          btApi = await connectApi();
          console.log("[loop] Reconnected.");
        } catch (e) {
          console.error("[loop] Reconnect failed:", e);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  await tick();
  const interval = setInterval(tick, INTERVAL_MS);

  const clean = async () => {
    clearInterval(interval);
    try {
      await btApi?.disconnect();
    } catch {}
    console.log("Shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", clean);
  process.on("SIGTERM", clean);
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  try {
    await btApi?.disconnect();
  } catch {}
  process.exit(1);
});
