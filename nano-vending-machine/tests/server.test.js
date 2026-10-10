/**
 * Tests for the Nano (XNO) Vending Machine.
 *
 * These exercise the express routes and the on-chain verifier with a mocked
 * public RPC (no real Nano spent, no network needed) so the whole flow runs
 * in CI on a plain `npm test`.
 */

const request = require('supertest');
const { xnoToRaw, isValidNanoAddress, verifyNanoPayment } = require('../services/nano-verifier');

// Monkey-patch global fetch to return canned block_info responses, keyed by
// the requested block hash. The verifier only talks to the RPC via fetch.
const FAKE_BLOCKS = {
  // a confirmed send paying the burn address for 0.01 XNO (state block format
  // with link_as_account so the verifier uses string comparison)
  [Array(64).fill('a').join('')]: {
    confirmed: true,
    amount: xnoToRaw('0.01').toString(),
    subtype: 'send',
    contents: {
      type: 'state',
      link_as_account: 'nano_1111111111111111111111111111111111111111111111111117353trpda',
    },
  },
};
const FAKE_MISSING = {
  error: 'Block not found',
};

function mockRpc() {
  return jest.fn(async (url, opts) => {
    const { hash } = JSON.parse(opts.body);
    const body = FAKE_BLOCKS[hash] || FAKE_MISSING;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  });
}

describe('nano-verifier', () => {
  beforeEach(() => {
    global.fetch = mockRpc();
  });
  afterEach(() => {
    delete global.fetch;
  });

  test('isValidNanoAddress accepts a real mainnet address', () => {
    expect(
      isValidNanoAddress('nano_1111111111111111111111111111111111111111111111111117353trpda')
    ).toBe(true);
    expect(isValidNanoAddress('not-an-address')).toBe(false);
  });

  test('xnoToRaw converts exactly with no float error', () => {
    expect(xnoToRaw('1')).toBe(1000000000000000000000000000000n);
    expect(xnoToRaw('0.01')).toBe(10000000000000000000000000000n);
    expect(xnoToRaw('0.0000001')).toBe(100000000000000000000000n);
  });

  test('verifies a confirmed send of the quoted amount to the quoted address', async () => {
    const result = await verifyNanoPayment({
      blockHash: Array(64).fill('a').join(''),
      payTo: 'nano_1111111111111111111111111111111111111111111111111117353trpda',
      minRaw: xnoToRaw('0.01'),
    });
    expect(result.verified).toBe(true);
  });

  test('fails closed on a missing block (not paid yet)', async () => {
    const result = await verifyNanoPayment({
      blockHash: Array(64).fill('b').join(''),
      payTo: 'nano_1111111111111111111111111111111111111111111111111117353trpda',
      minRaw: xnoToRaw('0.01'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('Block not found');
  });

  test('fails closed on an malformed block hash without any RPC call', async () => {
    global.fetch = jest.fn();
    const result = await verifyNanoPayment({
      blockHash: 'nope',
      payTo: 'nano_1111111111111111111111111111111111111111111111111117353trpda',
      minRaw: xnoToRaw('0.01'),
    });
    expect(result.verified).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fails closed when amount is below the quoted minimum', async () => {
    // amount in FAKE_BLOCKS is 0.01; require 0.02 -> underpaid
    const result = await verifyNanoPayment({
      blockHash: Array(64).fill('a').join(''),
      payTo: 'nano_1111111111111111111111111111111111111111111111111117353trpda',
      minRaw: xnoToRaw('0.02'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('amount below required minimum');
  });

  test('fails closed when paid to the wrong address', async () => {
    const result = await verifyNanoPayment({
      blockHash: Array(64).fill('a').join(''),
      payTo: 'nano_3' + '4'.repeat(59),
      minRaw: xnoToRaw('0.01'),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('paid to wrong address');
  });
});

describe('HTTP routes', () => {
  let app;
  beforeEach(() => {
    global.fetch = mockRpc();
    jest.resetModules();
    // fresh module so the singleton storageMap resets between tests
    delete require.cache[require.resolve('../server')];
    app = require('../server');
  });
  afterEach(() => {
    delete global.fetch;
    delete require.cache[require.resolve('../server')];
  });

  test('GET /health reports healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.protocol).toBe('nano-x402');
  });

  test('GET /inventory lists products priced in XNO', async () => {
    const res = await request(app).get('/inventory');
    expect(res.status).toBe(200);
    expect(res.body.accepted_tokens).toContain('XNO');
    expect(res.body.items[0].currency).toBe('XNO');
  });

  test('GET /buy/:id returns 402 with an exact XNO offer', async () => {
    const res = await request(app).get('/buy/classic-cola');
    expect(res.status).toBe(402);
    expect(res.headers['x402-accept']).toBe('nano:mainnet');
    expect(res.headers['x402-amount']).toBe('0.01');
    expect(res.body.payment_details.currency).toBe('XNO');
    expect(res.body.payment_details.recipient.startsWith('nano_')).toBe(true);
  });

  test('POST /confirm-payment dispenses a product after a verified block', async () => {
    const buy = await request(app).get('/buy/classic-cola');
    const paymentId = buy.body.payment_details.id;

    const res = await request(app)
      .post('/confirm-payment')
      .send({ payment_id: paymentId, block_hash: Array(64).fill('a').join('') });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.product.name).toBe('Classic Cola');
    expect(res.body.payment.finality).toContain('second');
  });

  test('POST /confirm-payment rejects an unverified block with 402', async () => {
    const buy = await request(app).get('/buy/classic-cola');
    const paymentId = buy.body.payment_details.id;

    const res = await request(app)
      .post('/confirm-payment')
      .send({ payment_id: paymentId, block_hash: Array(64).fill('b').join('') });
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('Block not found');
  });

  test('POST /confirm-payment rejects a payment already processed', async () => {
    const buy = await request(app).get('/buy/classic-cola');
    const paymentId = buy.body.payment_details.id;

    await request(app)
      .post('/confirm-payment')
      .send({ payment_id: paymentId, block_hash: Array(64).fill('a').join('') });
    const res = await request(app)
      .post('/confirm-payment')
      .send({ payment_id: paymentId, block_hash: Array(64).fill('a').join('') });
    expect(res.status).toBe(409);
  });
});
