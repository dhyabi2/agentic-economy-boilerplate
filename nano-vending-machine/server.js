/**
 * Nano (XNO) Vending Machine
 *
 * An x402 (HTTP 402 Payment Required) vending machine that settles on the
 * Nano network: zero-fee, no-gas, final in ~1 second, keyless on-chain
 * verification. The buyer pays the exact amount in XNO to the address this
 * machine quotes; the machine confirms the send block on a public RPC before
 * dispensing the product.
 *
 * Reuses the shared production utilities (storage, middleware, testing) like
 * the other protocol vending machines.
 */

require('dotenv').config();
const express = require('express');

const { verifyNanoPayment, xnoToRaw } = require('./services/nano-verifier');

// Import shared utilities
let middleware, storage;
try {
  const shared = require('../shared');
  middleware = shared.middleware;
  storage = shared.storage;
} catch (error) {
  console.warn('Shared utilities not available, using built-in alternatives');
}

const app = express();
const PORT = process.env.PORT || 3007;

// Initialize storage
let storageManager;
if (storage) {
  storageManager = storage.createStorage();
} else {
  // Fallback in-memory storage
  storageManager = {
    pendingPayments: new Map(),
    completedPayments: new Set(),
    async initialize() {
      return this;
    },
    async savePayment(id, data) {
      this.pendingPayments.set(id, data);
    },
    async getPayment(id) {
      return this.pendingPayments.get(id);
    },
    async deletePayment(id) {
      this.pendingPayments.delete(id);
    },
    async listPayments() {
      return Array.from(this.pendingPayments.keys());
    },
    async exists(id) {
      return this.pendingPayments.has(id) || this.completedPayments.has(id);
    },
  };
}

// Get logger
const logger = middleware ? middleware.logger : console;

// Nano configuration
const NANO_CONFIG = {
  accepted_tokens: ['XNO'],
  network: 'nano',
  // The exact-scheme offer pays THIS address. In .env for production; the
  // fallback is the well-known Nano burning address (valid shape) so the
  // machine runs out of the box.
  payTo: process.env.PAY_TO || 'nano_1111111111111111111111111111111111111111111111111117353trpda',
  prices: {
    'classic-cola': 0.01, // 0.01 XNO (~1 cent)
    'orange-fizz': 0.015,
    'grape-burst': 0.02,
    'premium-energy': 0.05,
  },
  // Minimum account receivable (open) threshold to avoid empty sends.
  receiveThresholdRaw: xnoToRaw('0.0000001'),
};

// Vending machine inventory
const inventory = {
  'classic-cola': { name: 'Classic Cola', stock: 100, description: 'Refreshing classic taste' },
  'orange-fizz': { name: 'Orange Fizz', stock: 75, description: 'Zesty orange flavor' },
  'grape-burst': { name: 'Grape Burst', stock: 50, description: 'Explosive grape goodness' },
  'premium-energy': {
    name: 'Premium Energy',
    stock: 25,
    description: 'High-caffeine energy boost',
  },
};

// Middleware setup
app.use(express.json());

if (middleware) {
  app.use(middleware.security.requestId);
  app.use(middleware.security.configureHelmet());
  app.use(middleware.security.configureCORS());
  app.use(middleware.security.sanitizeInput);
  app.use(middleware.agentDetection.agentMiddleware({ logActivity: true }));
  app.use(middleware.rateLimiter.createRateLimiter());
} else {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
  });
}

// Utility functions
function generatePaymentId() {
  return `nano_payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generateActivationCode() {
  return Math.random().toString(36).substr(2, 12).toUpperCase();
}

function nanoX402Headers(productId, paymentId) {
  const price = NANO_CONFIG.prices[productId];
  return {
    'x402-accept': 'nano:mainnet',
    'x402-amount': price.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
    'x402-recipient': NANO_CONFIG.payTo,
    'x402-memo': `Purchase: ${inventory[productId].name}`,
    'x402-network': 'nano',
    'x402-payment-id': paymentId,
    'x402-expiry': (Date.now() + 300000).toString(), // 5 minutes
  };
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    protocol: 'nano-x402',
    storage: storage ? 'shared-storage' : 'in-memory',
  });
});

// Get inventory
app.get('/inventory', (req, res) => {
  const publicInventory = Object.entries(inventory).map(([id, item]) => ({
    id,
    name: item.name,
    description: item.description,
    price: NANO_CONFIG.prices[id],
    inStock: item.stock > 0,
    currency: 'XNO',
  }));

  logger.info('Inventory requested', {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    itemsAvailable: publicInventory.length,
    agentId: req.agentId,
    agentType: req.agentType,
  });

  res.json({
    items: publicInventory,
    accepted_tokens: NANO_CONFIG.accepted_tokens,
    network: NANO_CONFIG.network,
    pay_to: NANO_CONFIG.payTo,
  });
});

// Purchase endpoint - Returns 402 Payment Required with an exact XNO offer
app.get('/buy/:productId', async (req, res) => {
  const { productId } = req.params;

  try {
    if (!inventory[productId]) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (inventory[productId].stock <= 0) {
      return res.status(410).json({ error: 'Product out of stock' });
    }

    const paymentId = generatePaymentId();
    const paymentData = {
      productId,
      token: 'XNO',
      amount: NANO_CONFIG.prices[productId],
      amountRaw: xnoToRaw(NANO_CONFIG.prices[productId]).toString(),
      payTo: NANO_CONFIG.payTo,
      timestamp: Date.now(),
      ip: req.ip,
      agentId: req.agentId,
      agentType: req.agentType,
      status: 'pending',
    };

    await storageManager.savePayment(paymentId, paymentData);

    const headers = nanoX402Headers(productId, paymentId);

    logger.info('Payment required', {
      paymentId,
      productId,
      amount: NANO_CONFIG.prices[productId],
      token: 'XNO',
      ip: req.ip,
      agentId: req.agentId,
    });

    res
      .status(402)
      .set(headers)
      .json({
        error: 'Payment Required',
        message: `Please pay ${NANO_CONFIG.prices[productId]} XNO to ${NANO_CONFIG.payTo} to purchase ${inventory[productId].name}`,
        payment_details: {
          id: paymentId,
          amount: NANO_CONFIG.prices[productId],
          currency: 'XNO',
          recipient: NANO_CONFIG.payTo,
          network: NANO_CONFIG.network,
          expires_at: new Date(Date.now() + 300000).toISOString(),
        },
      });
  } catch (error) {
    logger.error('Purchase error', { error: error.message, productId, ip: req.ip });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Payment confirmation endpoint - verifies the Nano send block on-chain
app.post('/confirm-payment', async (req, res) => {
  const { payment_id, block_hash } = req.body;

  try {
    if (!payment_id || !block_hash) {
      return res.status(400).json({ error: 'Missing required fields: payment_id, block_hash' });
    }

    const paymentDetails = await storageManager.getPayment(payment_id);
    if (!paymentDetails) {
      return res.status(404).json({ error: 'Payment not found or expired' });
    }
    if (paymentDetails.status === 'completed') {
      return res.status(409).json({ error: 'Payment already processed' });
    }
    if (Date.now() - paymentDetails.timestamp > 300000) {
      paymentDetails.status = 'expired';
      await storageManager.savePayment(payment_id, paymentDetails);
      return res.status(408).json({ error: 'Payment expired' });
    }

    // Real on-chain verification against a public Nano RPC. Fails closed:
    // a missing/unconfirmed/wrong-amount/wrong-address block never passes.
    const result = await verifyNanoPayment({
      blockHash: block_hash,
      payTo: paymentDetails.payTo,
      minRaw: paymentDetails.amountRaw,
    });

    if (!result.verified) {
      logger.warn('Invalid or missing payment', {
        payment_id,
        block_hash,
        reason: result.reason,
        ip: req.ip,
      });
      return res.status(402).json({
        error: 'Payment not verified',
        reason: result.reason,
        message: 'The block is not a confirmed send of the quoted amount to the quoted address.',
      });
    }

    const product = inventory[paymentDetails.productId];
    product.stock -= 1;

    paymentDetails.status = 'completed';
    paymentDetails.block_hash = block_hash;
    paymentDetails.completed_at = Date.now();
    await storageManager.savePayment(payment_id, paymentDetails);

    const digitalProduct = {
      id: `product_${Date.now()}`,
      name: product.name,
      description: product.description,
      serial_number: `SN${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
      activation_code: generateActivationCode(),
      expires_at: new Date(Date.now() + 86400000).toISOString(), // 24 hours
      block_hash,
    };

    logger.info('Purchase completed', {
      payment_id,
      productId: paymentDetails.productId,
      block_hash,
      amountRaw: result.block ? result.block.amount : paymentDetails.amountRaw,
      ip: req.ip,
      agentId: paymentDetails.agentId,
    });

    res.json({
      success: true,
      message: 'Payment confirmed on-chain and product dispensed',
      payment: {
        id: payment_id,
        amount: paymentDetails.amount,
        currency: 'XNO',
        block_hash,
        finality: '~1 second, zero fee',
      },
      product: digitalProduct,
      dispensed_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Payment confirmation error', { error: error.message, payment_id, ip: req.ip });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payment status
app.get('/payment/:paymentId/status', async (req, res) => {
  const { paymentId } = req.params;

  try {
    const payment = await storageManager.getPayment(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status === 'completed') {
      res.json({
        status: 'completed',
        block_hash: payment.block_hash,
        completed_at: payment.completed_at,
      });
    } else if (payment.status === 'pending') {
      const isExpired = Date.now() - payment.timestamp > 300000;
      if (isExpired) {
        payment.status = 'expired';
        await storageManager.savePayment(paymentId, payment);
        res.json({ status: 'expired' });
      } else {
        res.json({
          status: 'pending',
          expires_in: Math.max(0, 300000 - (Date.now() - payment.timestamp)),
        });
      }
    } else {
      res.json({ status: payment.status });
    }
  } catch (error) {
    logger.error('Payment status error', { error: error.message, paymentId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling
if (middleware) {
  app.use(middleware.errorHandler.notFoundHandler);
  app.use(middleware.errorHandler.errorHandler);
} else {
  app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });
  app.use((error, req, res, _next) => {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  });
}

// Cleanup expired payments periodically (only when run as a server, so an
// import in tests does not keep the event loop alive)
if (require.main === module) {
  setInterval(async () => {
    try {
      const paymentKeys = await storageManager.listPayments();
      const now = Date.now();
      for (const key of paymentKeys) {
        const paymentId = key.replace('payment:', '');
        const payment = await storageManager.getPayment(paymentId);
        if (payment && payment.status === 'pending' && now - payment.timestamp > 300000) {
          payment.status = 'expired';
          await storageManager.savePayment(paymentId, payment);
          logger.info('Expired payment cleaned up', { paymentId });
        }
      }
    } catch (error) {
      logger.error('Cleanup error', { error: error.message });
    }
  }, 60000);
}

// Start server
function startServer() {
  if (require.main === module) {
    storageManager
      .initialize()
      .then(() => {
        logger.info('✓ Storage initialized');
        app.listen(PORT, () => {
          logger.info(`\n🚀 Nano (XNO) Vending Machine started on port ${PORT}`);
          logger.info('📍 Endpoints available:');
          logger.info(`   GET  /health - Health check`);
          logger.info(`   GET  /inventory - View available products`);
          logger.info(`   GET  /buy/:productId - Purchase product (returns 402 XNO offer)`);
          logger.info(`   POST /confirm-payment - Confirm Nano send block on-chain`);
          logger.info(`   GET  /payment/:id/status - Check payment status`);
          logger.info('');
          logger.info('🔗 Try it out:');
          logger.info(`   curl http://localhost:${PORT}/inventory`);
          logger.info(`   curl http://localhost:${PORT}/buy/classic-cola`);
          logger.info('');
          logger.info('💰 Accepted:', NANO_CONFIG.accepted_tokens.join(', '));
          logger.info('📍 Pay-to:', NANO_CONFIG.payTo);
        });
      })
      .catch((err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
      });
  }
}

startServer();

module.exports = app;
