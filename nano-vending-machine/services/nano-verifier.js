/**
 * Nano (XNO) on-chain payment verifier
 *
 * Keyless settlement check: a Nano payment is a signed send block broadcast
 * to the network. Anyone can read it - no wallet, no API key, no node of your
 * own. We verify a buyer's claim by asking a public Nano RPC for the block and
 * requiring that it is confirmed, is a "send", sends at least the expected raw
 * amount, and pays the exact address this vending machine quoted.
 *
 * This mirrors how an x402 merchant settles an exact-amount offer on a network
 * that is final in ~1 second with zero fees, instead of trusting a client-side
 * flag or a simulated check.
 */

const NANO_RPC_BASE = (process.env.NANO_RPC_BASE || 'https://rpc.nano.to').replace(/\/$/, '');

// A Nano raw balance base-32 checksum-less address is 64 characters starting
// with "nano_" or "xrb_". We validate the shape before any network call so an
// obviously malformed proof fails closed (ends as 402) without hitting the RPC.
const NANO_ADDRESS_RE = /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
const BLOCK_HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Convert a decimal XNO string (e.g. "0.01") to raw (1 XNO = 1e30 raw),
 * exactly - never through a JS Number, which loses precision above 2^53
 * (1 XNO would become 1000000000000000019884624838656n).
 */
function xnoToRaw(xno) {
  if (typeof xno !== 'string') xno = String(xno);
  if (xno.includes('e') || xno.includes('E')) {
    // expand scientific notation (e.g. "1e-7") to a plain decimal first
    xno = Number(xno).toFixed(30).replace(/0+$/, '').replace(/\.$/, '');
  }
  const [intPart = '0', fracPart = ''] = xno.split('.');
  const frac = fracPart.padEnd(30, '0').slice(0, 30);
  return BigInt(intPart || '0') * 10n ** 30n + BigInt(frac || '0');
}

/**
 * Validate a Nano address shape. Returns true for a plausible mainnet
 * address (base-32 alphabet, correct length, correct leading digit).
 */
function isValidNanoAddress(addr) {
  return typeof addr === 'string' && NANO_ADDRESS_RE.test(addr);
}

/**
 * Query a public Nano RPC for a block and return the normalized block data.
 * Throws on network error or a missing block so the caller can fail closed.
 */
async function fetchBlock(hash) {
  const payload = {
    action: 'block_info',
    json_block: 'true',
    hash: hash.toLowerCase(),
  };
  const res = await fetch(NANO_RPC_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Nano RPC error (HTTP ${res.status})`);
  }
  const data = await res.json();
  // rpc.nano.to returns HTTP 200 with { error: "Block not found" } for a
  // hash that does not exist; treat that as a missing block.
  if (data.error === 'Block not found') {
    throw new Error('Block not found');
  }
  if (data.error) {
    throw new Error(`Nano RPC error: ${data.error}`);
  }
  if (!data.contents || !data.contents.type) {
    throw new Error('Malformed block_info response');
  }
  return data;
}

/**
 * Verify a claimed Nano payment.
 *
 * @param {object} opts
 * @param {string} opts.blockHash  - the 64-hex block hash a buyer submits as proof
 * @param {string} opts.payTo      - the Nano address this vending machine quoted
 * @param {string|bigint} opts.minRaw - minimum raw amount expected (BigInt or string)
 * @returns {Promise<{verified: boolean, reason?: string, block?: object}>}
 */
async function verifyNanoPayment({ blockHash, payTo, minRaw }) {
  if (!BLOCK_HASH_RE.test(blockHash || '')) {
    return { verified: false, reason: 'invalid block hash' };
  }
  if (!isValidNanoAddress(payTo)) {
    return { verified: false, reason: 'invalid destination address' };
  }

  let block;
  try {
    block = await fetchBlock(blockHash);
  } catch (error) {
    // A missing or unreadable block means "not paid yet" - fail closed to 402.
    return { verified: false, reason: error.message };
  }

  const contents = block.contents;
  // Modern Nano v21+ blocks use type "state" with subtype "send" at the top
  // level, and carry the recipient as `link_as_account` (a nano_ string) or as
  // the raw `destination`/`link` hex. Legacy (pre-v21) send blocks put the
  // recipient in `contents.destination`. We compare the recipient string with
  // the quoted pay-to address directly (the RPC already converts to nano_).
  if (contents.type === 'send' || (contents.type === 'state' && block.subtype === 'send')) {
    // it is a send
  } else {
    return { verified: false, reason: 'block is not a send' };
  }
  if (!block.confirmed) {
    return { verified: false, reason: 'block not confirmed' };
  }

  // The recipient of a send is returned by the RPC in address form: for modern
  // state blocks it is `link_as_account`, for legacy sends it is
  // `contents.destination`. Compare it with the quoted pay-to address directly
  // (the node already converts the link to a nano_ address). If the RPC does
  // not give us an address string, fail closed rather than guess.
  const recipientAddr = contents.link_as_account || contents.destination;
  if (!recipientAddr || !recipientAddr.includes('_')) {
    return { verified: false, reason: 'recipient not in address form' };
  }
  if (recipientAddr !== payTo) {
    return { verified: false, reason: 'paid to wrong address' };
  }

  const amountRaw = BigInt(block.amount || '0');
  const minRawBig = typeof minRaw === 'bigint' ? minRaw : BigInt(minRaw);
  if (amountRaw < minRawBig) {
    return {
      verified: false,
      reason: 'amount below required minimum',
      block,
    };
  }

  return { verified: true, block };
}

module.exports = {
  NANO_RPC_BASE,
  xnoToRaw,
  isValidNanoAddress,
  verifyNanoPayment,
  fetchBlock,
};
