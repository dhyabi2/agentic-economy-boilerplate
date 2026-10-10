# Nano (XNO) Vending Machine

An **x402 vending machine that settles on the Nano network** — zero gas fees, no
token wrapping, no relayer, and final in about a second with **real on-chain
verification** over a public RPC. It is the same digital vending machine as the
other protocol examples, so you can compare it side-by-side.

> The other x402 example (Coinbase/USDC-on-Base) simulates transaction
> verification with a placeholder check; this one actually reads the confirmed
> block from the network, so it ships the exact fix the project lists under
> "Add real block chain verification (x402)". The buyer pays XNO; the machine
> confirms the send block on `https://rpc.nano.to` before dispensing.

## Why Nano here

- **Fee = 0.** A Nano transfer carries no protocol fee; micropayments stay
  micropayments.
- **Final ~1 second.** Settlement is on the Nano ledger itself, no L2, no
  batching risk.
- **Keyless.** Verifying a payment needs no wallet and no API key — read the
  block from a public RPC and check it is a *confirmed send* of the quoted
  amount to the quoted address.
- **Truly peer-to-peer.** The buyer pays the exact address the 402 names. No
  issuer can freeze, reverse or censor it.

## Quick start

```bash
cd nano-vending-machine
cp .env.example .env   # set PAY_TO to the Nano address that receives payment
npm install
npm start
```

Then try it:

```bash
curl http://localhost:3007/inventory
curl http://localhost:3007/buy/classic-cola
# → 402 Payment Required with x402 headers: x402-accept: nano:mainnet

# After paying the exact XNO amount to the quoted nano_ address:
curl -X POST http://localhost:3007/confirm-payment \
  -H 'Content-Type: application/json' \
  -d '{"payment_id":"<id from the 402>","block_hash":"<64-hex send block hash>"}'
# → 200: product dispensed, payment confirmed on-chain
```

## How a payment is verified (the keyless on-chain check)

The machine never trusts a client flag or a simulated result. `POST
/confirm-payment` with a `block_hash`:

1. Validates the block hash and `pay_to` address shape (fails closed — no RPC
   call for an obviously malformed proof).
2. Asks a public Nano RPC: `POST {"action":"block_info","json_block":"true",
   "hash":"<block_hash>"}`.
3. Requires the block is **confirmed**, is a **send**, paid **exactly this
   machine's quoted address**, and moved **at least the quoted raw amount**.
4. Only then does it decrement stock and dispense the digital product.

Any failure (missing block, unconfirmed, wrong amount, wrong address, RPC
unreachable) returns **402** — it never passes.

## Tests (network-free)

```bash
cd nano-vending-machine
npm test
```

13 tests cover exact raw-amount conversion (no float error above 2^53), the
verifier's four fail-closed cases, and the full HTTP flow (402 offer →
confirm → dispense, and rejection of unverified/already-processed payments)
against a mocked RPC — no real Nano spent.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3007` | HTTP port for this vending machine |
| `PAY_TO` | demo address | The Nano address that receives XNO — set this to yours in production |
| `NANO_RPC_BASE` | `https://rpc.nano.to` | Public Nano RPC used for on-chain verification |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/inventory` | List products priced in XNO |
| GET | `/buy/:productId` | Purchase — returns `402` with an exact XNO offer |
| POST | `/confirm-payment` | Verify the Nano send block on-chain and dispense |
| GET | `/payment/:id/status` | Check payment status |

## Docker

```bash
docker build -t nano-vending-machine .
docker run -p 3007:3007 --env PAY_TO=<your_nano_address> nano-vending-machine
```

## How to pay from an agent (the x402 exact-scheme flow)

1. `GET /buy/classic-cola` → `402` with `x402-accept: nano:mainnet`,
   `x402-amount: 0.01`, `x402-recipient: nano_...`.
2. Build and broadcast a Nano send block for the exact raw amount to that
   `x402-recipient` (any Nano wallet or the `nano_pay` client in the
   `feeless402` PyPI package can do this — no account, no gas).
3. Retry `POST /confirm-payment` with the resulting block hash as the proof.
4. The machine verifies it on-chain and returns the product.

License: MIT.
