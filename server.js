require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');

const requiredEnv = [
  'ZAPUPI_ZAP_KEY',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'PUBLIC_BASE_URL'
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const app = express();

app.set('trust proxy', 1);

const allowedOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      allowedOrigins.length === 0 ||
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed'));
  }
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.use('/api/', rateLimit({
  windowMs: 60000,
  limit: 60
}));

const CREATE_URL = 'https://pay.zapupi.com/api/create-order';
const STATUS_URL = 'https://pay.zapupi.com/api/order-status';

const BASE_URL = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
const RETURN_URL = process.env.APP_RETURN_URL || '';

function errorResponse(res, code, message) {
  return res.status(code).json({
    status: 'error',
    success: false,
    message
  });
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/i);

    if (!match) {
      return errorResponse(res, 401, 'Login required');
    }

    req.user = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (error) {
    return errorResponse(res, 401, 'Invalid login token');
  }
}

async function zapupiRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || 'ZapUPI request failed');
  }

  return data;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();

  if (['success', 'successful', 'paid', 'completed'].includes(status)) {
    return 'success';
  }

  if (['failed', 'failure', 'cancelled', 'canceled', 'expired'].includes(status)) {
    return 'failed';
  }

  return 'pending';
}

async function verifyPayment(orderId) {
  const result = await zapupiRequest(STATUS_URL, {
    zap_key: process.env.ZAPUPI_ZAP_KEY,
    order_id: orderId
  });

  if (result.status !== 'success' || !result.data) {
    throw new Error(result.message || 'Payment verification failed');
  }

  return result.data;
}

async function creditWallet(orderId, order, payment) {
  const expectedAmount = Number(order.amount);
  const paidAmount = payment.amount !== undefined && payment.amount !== null && payment.amount !== ''
    ? Number(payment.amount)
    : expectedAmount;

  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    throw new Error('Invalid order amount');
  }

  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.009) {
    throw new Error(`Payment amount mismatch: expected ${expectedAmount}, got ${paidAmount}`);
  }

  const userRef = db.ref(`users/${order.uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists()) {
    throw new Error(`Target user not found: ${order.uid}`);
  }

  // Step 1: Claim order idempotently so double webhook/status calls never double-credit
  const claimRef = db.ref(`zapupiProcessedOrders/${orderId}`);
  const claimResult = await claimRef.transaction(current => {
    if (current) {
      return; // Already claimed/processed
    }
    return {
      uid: order.uid,
      amount: expectedAmount,
      claimedAt: admin.database.ServerValue.TIMESTAMP
    };
  });

  const alreadyProcessed = !claimResult.committed;

  // Step 2: Atomically add expectedAmount to user's balance if not already credited
  if (!alreadyProcessed) {
    const balanceRef = db.ref(`users/${order.uid}/balance`);
    const balanceTx = await balanceRef.transaction(currentBalance => {
      return Number(currentBalance || 0) + expectedAmount;
    });

    if (!balanceTx.committed) {
      throw new Error('Balance transaction did not commit');
    }

    await db.ref(`transactions/${order.uid}/zapupi_${orderId}`).set({
      type: 'deposit',
      amount: expectedAmount,
      description: 'ZapUPI Wallet Recharge',
      timestamp: admin.database.ServerValue.TIMESTAMP,
      details: {
        orderId,
        txnId: payment.txn_id || '',
        utr: payment.utr || ''
      }
    });
  }

  await db.ref(`zapupiOrders/${orderId}`).update({
    status: 'success',
    credited: true,
    verifiedAmount: paidAmount,
    txnId: payment.txn_id || '',
    utr: payment.utr || '',
    verifiedAt: admin.database.ServerValue.TIMESTAMP
  });

  return {
    credited: true,
    alreadyCredited: alreadyProcessed
  };
}

async function processOrder(orderId) {
  const orderSnap = await db.ref(`zapupiOrders/${orderId}`).get();

  if (!orderSnap.exists()) {
    throw new Error('Order not found');
  }

  const order = orderSnap.val();

  if (order.status === 'success' && order.credited === true) {
    return {
      payment_status: 'success',
      order_id: orderId,
      credited: true
    };
  }

  const payment = await verifyPayment(orderId);
  const status = normalizeStatus(payment.status);

  if (status === 'success') {
    await creditWallet(orderId, order, payment);

    return {
      payment_status: 'success',
      order_id: orderId,
      credited: true
    };
  }

  await db.ref(`zapupiOrders/${orderId}`).update({
    status,
    lastCheckedAt: admin.database.ServerValue.TIMESTAMP
  });

  return {
    payment_status: status,
    order_id: orderId,
    credited: false
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post(
  '/api/payments/create-order',
  authenticate,
  async (req, res) => {
    try {
      const amount = Number(req.body.amount);

      if (
        !Number.isFinite(amount) ||
        amount < 10 ||
        amount > 1000 ||
        Math.round(amount * 100) !== amount * 100
      ) {
        return errorResponse(
          res,
          400,
          'Amount must be between 10 and 1000'
        );
      }

      const uid = req.user.uid;

      const orderId =
        'ZP' +
        Date.now() +
        crypto.randomBytes(5).toString('hex').toUpperCase();

      const orderRef = db.ref(`zapupiOrders/${orderId}`);

      await orderRef.set({
        uid,
        amount,
        status: 'creating',
        credited: false,
        createdAt: admin.database.ServerValue.TIMESTAMP
      });

      const payload = {
        zap_key: process.env.ZAPUPI_ZAP_KEY,
        order_id: orderId,
        amount: String(amount),
        remark: `Wallet recharge ${uid}`,
        webhook_url: `${BASE_URL}/api/zapupi/webhook`
      };

      if (req.user.phone_number) {
        payload.customer_mobile =
          req.user.phone_number.replace(/\D/g, '').slice(-10);
      }

      if (RETURN_URL) {
        const separator = RETURN_URL.includes('?') ? '&' : '?';

        payload.success_url =
          `${RETURN_URL}${separator}zapupi=success&order_id=${orderId}`;

        payload.failed_url =
          `${RETURN_URL}${separator}zapupi=failed&order_id=${orderId}`;

        payload.timeout_url =
          `${RETURN_URL}${separator}zapupi=pending&order_id=${orderId}`;
      }

      const gateway = await zapupiRequest(CREATE_URL, payload);
      console.log('ZapUPI create-order response:', JSON.stringify(gateway));

      const paymentUrl = gateway.payment_url || gateway.data?.payment_url || '';

      if (gateway.status !== 'success' || !paymentUrl) {
        await orderRef.update({ status: 'failed' });

        return errorResponse(
          res,
          502,
          gateway.message || 'ZapUPI payment link was not received'
        );
      }

      await orderRef.update({
        status: 'pending',
        paymentUrl,
        txnId: gateway.txn_id || ''
      });

      res.json({
        status: 'success',
        order_id: orderId,
        payment_url: paymentUrl,
        paymentUrl
      });
    } catch (error) {
      console.error('Create order error:', error.message);
      errorResponse(res, 502, 'Unable to create payment order');
    }
  }
);

app.get(
  '/api/payments/:orderId/status',
  authenticate,
  async (req, res) => {
    try {
      const orderId = req.params.orderId;

      if (!/^ZP[0-9A-Z]+$/i.test(orderId)) {
        return errorResponse(res, 400, 'Invalid order ID');
      }

      const snap = await db.ref(`zapupiOrders/${orderId}`).get();

      if (!snap.exists()) {
        return errorResponse(res, 404, 'Order not found');
      }

      if (snap.val().uid !== req.user.uid) {
        return errorResponse(res, 403, 'Access denied');
      }

      const result = await processOrder(orderId);
      res.json(result);
    } catch (error) {
      console.error('Status error:', error.message);
      errorResponse(res, 502, 'Payment verification unavailable');
    }
  }
);

app.post('/api/payouts/withdraw', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const amount = Number(req.body.amount);
    const upiId = String(req.body.upiId || req.body.accountInfo || '').trim();
    const withdrawalId = String(req.body.withdrawalId || '').trim();
    const method = String(req.body.method || 'UPI').trim();

    if (!Number.isFinite(amount) || amount < 10 || amount > 100000) {
      return errorResponse(res, 400, 'Invalid withdrawal amount');
    }

    if (!upiId || !upiId.includes('@')) {
      return errorResponse(res, 400, 'Valid UPI ID is required');
    }

    if (!process.env.PAYOUT_API_URL || !process.env.PAYOUT_API_KEY) {
      return errorResponse(
        res,
        501,
        'Payout gateway credentials are not configured on server'
      );
    }

    const payoutKey = withdrawalId || `WD_${uid}_${Date.now()}`;
    const claimRef = db.ref(`payoutProcessedWithdrawals/${payoutKey}`);
    const claimResult = await claimRef.transaction(current => {
      if (current) {
        return;
      }
      return {
        uid,
        amount,
        upiId,
        claimedAt: admin.database.ServerValue.TIMESTAMP
      };
    });

    if (!claimResult.committed) {
      return errorResponse(res, 409, 'Withdrawal payout is already being processed');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.PAYOUT_API_KEY}`,
      'X-Client-Id': process.env.PAYOUT_API_KEY
    };

    if (process.env.PAYOUT_SECRET_KEY) {
      headers['X-Client-Secret'] = process.env.PAYOUT_SECRET_KEY;
    }

    const payoutResponse = await fetch(process.env.PAYOUT_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transfer_id: payoutKey,
        order_id: payoutKey,
        uid,
        amount,
        upi_id: upiId,
        vpa: upiId,
        method,
        remark: `Tournament withdrawal ${payoutKey}`
      }),
      signal: AbortSignal.timeout(15000)
    });

    const payoutData = await payoutResponse.json().catch(() => ({}));

    if (!payoutResponse.ok || payoutData.success === false || payoutData.status === 'error') {
      await claimRef.remove();
      if (withdrawalId) {
        await db.ref(`withdrawals/${withdrawalId}`).update({
          status: 'failed',
          failureReason: payoutData.message || 'Payout gateway transfer failed',
          updatedAt: admin.database.ServerValue.TIMESTAMP
        });
      }
      return errorResponse(
        res,
        502,
        payoutData.message || 'UPI transfer failed'
      );
    }

    const rawStatus = String(
      payoutData.status || payoutData.data?.status || 'completed'
    ).toLowerCase();
    const normalizedPayoutStatus = ['pending', 'processing', 'queued'].includes(rawStatus)
      ? 'processing'
      : 'completed';

    const utr =
      payoutData.utr ||
      payoutData.data?.utr ||
      payoutData.rrn ||
      payoutData.data?.rrn ||
      payoutData.payout_id ||
      payoutData.reference_id ||
      '';

    if (withdrawalId) {
      await db.ref(`withdrawals/${withdrawalId}`).update({
        status: normalizedPayoutStatus,
        utr,
        payoutResponse: payoutData,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
        completedAt: admin.database.ServerValue.TIMESTAMP
      });
    }

    return res.json({
      success: true,
      status: normalizedPayoutStatus,
      utr,
      payout_id: payoutData.payout_id || payoutData.reference_id || payoutKey
    });
  } catch (error) {
    console.error('Payout withdraw error:', error.message);
    return errorResponse(res, 502, 'Unable to process UPI payout');
  }
});

app.post('/api/zapupi/webhook', async (req, res) => {
  const orderId = String(req.body.order_id || req.body.orderId || '');

  if (!orderId) {
    return res.status(200).json({ status: 'ok' });
  }

  try {
    const snap = await db.ref(`zapupiOrders/${orderId}`).get();

    if (snap.exists()) {
      await processOrder(orderId);
    } else {
      console.warn('Webhook received for unknown orderId:', orderId);
    }
  } catch (error) {
    console.error('Webhook error:', error.message);
  }

  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`ZapUPI backend running on port ${PORT}`);
});
