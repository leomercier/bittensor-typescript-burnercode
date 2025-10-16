# Burner SN121 Vote-0

A tiny Node/Bun script that gives **100% weight to UID=0** on **Bittensor subnet 121**.
It supports both **Direct `setWeights`** and **Commit/Reveal (CRv1)**, auto-detects on-chain hyperparameters via `btApi.query.subtensorModule`, and runs every **1 minute**.

---

## Features

- Subnet **121** by default (override with `NETUID`).
- Chooses **Direct** or **CR** mode (`WEIGHTS_MODE=AUTO|DIRECT|CR`).
- Reads on-chain hyperparams (via storage):

  - `tempo` → epoch length in blocks
  - `revealPeriodEpochs` → commit→reveal gap (epochs)
  - `weightsSetRateLimit` → commit cooldown (blocks)
  - `weightsVersionKey` → version key

- Persists **pending commit** to disk; reveals in the **correct epoch**.
- Respect **commit rate limit** to avoid `CommittingWeightsTooFast`.
- JSON debug logs for **commit** and **reveal** tuples.

---

## Requirements

- Node 18+ or Bun.
- WS-capable runtime (`ws` is installed by Polkadot API).

Install deps:

```bash
# npm
npm i @polkadot/api @polkadot/keyring @polkadot/util-crypto @polkadot/util ws dotenv

# or bun
bun add @polkadot/api @polkadot/keyring @polkadot/util-crypto @polkadot/util ws dotenv
```

---

## Quick Start

```bash
# Auto mode (prefers setWeights; falls back to commit→reveal when required)
WEIGHTS_MODE=AUTO \
NETUID=121 \
TARGET_UID=0 \
node burner-sn121-vote0.js
```

### Recommended for SN121 (typically CR + versionKey=0)

```bash
WEIGHTS_MODE=CR \
NETUID=121 \
TARGET_UID=0 \
VERSION_KEY=0 \
node burner-sn121-vote0.js
```

**Tip:** Provide your hotkey mnemonic:

```bash
MNEMONIC="abandon abandon ... zoo" node burner-sn121-vote0.js
```

If omitted, a **burner mnemonic** is generated and printed.

---

## Environment Variables

| Var                        | Default                                     | What it does                                                  |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `RPC_URL`                  | `wss://entrypoint-finney.opentensor.ai:443` | Node WS endpoint                                              |
| `NETUID`                   | `121`                                       | Subnet ID                                                     |
| `TARGET_UID`               | `0`                                         | The UID to weight 100%                                        |
| `WEIGHTS_MODE`             | `AUTO`                                      | `AUTO`, `DIRECT` (setWeights only), `CR` (commit/reveal only) |
| `MNEMONIC`                 | _(none)_                                    | Hotkey seed (sr25519)                                         |
| `TEST_MODE`                | `false`                                     | If `true`, logs but **doesn’t send** txs                      |
| `STATE_DIR`                | `.burner-state`                             | Local dir for pending/meta files                              |
| `VERSION_KEY`              | _(none)_                                    | Override version key; else use on-chain `weightsVersionKey`   |
| `EPOCH_LENGTH_BLOCKS`      | `101`                                       | Fallback epoch size if storage query fails                    |
| `COMMIT_RATE_LIMIT_BLOCKS` | `100`                                       | Fallback rate limit if storage query fails                    |

---

## How It Works

1. **Hyperparams refresh** (throttled ~5 min) via:

   - `query.subtensorModule.tempo(NETUID)`
   - `query.subtensorModule.commitRevealWeightsEnabled(NETUID)`
   - `query.subtensorModule.revealPeriodEpochs(NETUID)`
   - `query.subtensorModule.weightsSetRateLimit(NETUID)`
   - `query.subtensorModule.weightsVersionKey(NETUID)`

2. **Every minute**:

   - If **pending commit** exists, compute the **reveal epoch** (`commitEpoch + revealPeriodEpochs`) and:

     - if before: wait,
     - if in: **reveal**; delete pending,
     - if missed: re-commit new payload.

   - If no pending:

     - Try **Direct `setWeights`** (unless `WEIGHTS_MODE=CR`).
     - If rejected (CR enabled), **commit** and save pending.
     - Respect **weightsSetRateLimit** between commits.

3. **Commit/Reveal payload**:

   - We hash `(AccountId, u16, Vec<u16>, Vec<u16>, u64, Vec<u16>)`
     → `(address, netuid, uids, weights, versionKey, salt)` using `blake2_256`.
   - On reveal, we **recompute** the hash to debug `CommitNotFound`.

**State files** (in `STATE_DIR`):

- `pending_<address>_<netuid>.json` — saved commit (uids, weights, salt, versionKey, commitBlock, commitHash).
- `meta_<address>_<netuid>.json` — `lastCommitBlock`, `lastCommitHash` to enforce cooldown.

---

## Logs & Debug

You will see entries like:

```text
[hp] tempo (epoch length) = 101 blocks
[hp] revealPeriodEpochs = 1 epoch(s)
[hp] weightsSetRateLimit = 100 blocks
[hp] weightsVersionKey = 0
```

Commit tuple (JSON):

```json
[commit:debug] {
  "address": "5F...",
  "netuid": 121,
  "uids": [0],
  "values": [65535],
  "versionKey": "0",
  "salt_u16_len": 32,
  "commitHash": "0x..."
}
```

Reveal tuple (JSON):

```json
[reveal:debug] {
  "address": "5F...",
  "netuid": 121,
  "uids": [0],
  "values": [65535],
  "versionKey": "0",
  "salt_u16_len": 32,
  "recomputedCommitHash": "0x...",
  "pendingCommitHash": "0x..."
}
```

---

## Troubleshooting

- **`Invalid Transaction: Custom error: 1`**
  Usually means **Direct setWeights** on a CR-enabled subnet. Use `WEIGHTS_MODE=CR` or keep `AUTO`.

- **`Custom error: 16 (CommitNotFound)`** at reveal

  - Wrong reveal epoch: script now waits until **exact epoch** (`commitEpoch + revealPeriodEpochs`).
  - Mismatched payload: check `commit:debug` vs `reveal:debug`. Ensure `versionKey` is correct (SN121 often `0`).
  - Stale pending: delete `pending_*.json`.

- **`CommittingWeightsTooFast`**
  Respect `weightsSetRateLimit`. The script remembers `lastCommitBlock` and waits:

  ```
  [tick] Commit cooldown: 37/100 blocks since last commit — skipping commit this tick.
  ```

- **Stuck at `Waiting for reveal epoch`**
  Normal. It only reveals in **commitEpoch + revealPeriodEpochs**, not “any time after”.

- **Reset state**

  ```bash
  rm -f .burner-state/pending_*_121.json .burner-state/meta_*_121.json
  ```

---

## Running with Bun

```bash
bun run index.ts
```

Same env vars apply. Bun’s printf can be quirky; this script uses **JSON** logs for reliability.

---

## Security

- **Never** commit your mnemonic. Prefer environment variables or a secure secret store.
- This script signs transactions locally; keep the host secure.

---

## License

MIT — do whatever you like, no warranty.
