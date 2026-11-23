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
  const status = String(value || '').toLowerCase();

  if (['success', 'successful', 'paid'].includes(status)) {
    return 'success';
  }

  if (['failed', 'failure', 'cancelled', 'canceled'].includes(status)) {
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
    throw new Error('Payment verification failed');
  }

  return result.data;
}

async function creditWallet(orderId, order, payment) {
  const expectedAmount = Number(order.amount);
  const paidAmount = Number(payment.amount);

  if (
    !Number.isFinite(paidAmount) ||
    Math.abs(paidAmount - expectedAmount) > 0.009
  ) {
    throw new Error('Payment amount mismatch');
  }

  const userRef = db.ref(`users/${order.uid}`);

  const transaction = await userRef.transaction(profile => {
    if (!profile) return;

    profile.processedZapupiOrders =
      profile.processedZapupiOrders || {};

    if (profile.processedZapupiOrders[orderId]) {
      return profile;
    }

    profile.balance =
      Number(profile.balance || 0) + expectedAmount;

    profile.processedZapupiOrders[orderId] = true;

    return profile;
  });

  const profile = transaction.snapshot.val();

  if (
    !profile ||
    !profile.processedZapupiOrders ||
    !profile.processedZapupiOrders[orderId]
  ) {
    throw new Error('Wallet credit failed');
  }

  await db.ref(
    `transactions/${order.uid}/zapupi_${orderId}`
  ).set({
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
    alreadyCredited: !transaction.committed
  };
}

async function processOrder(orderId) {
  const orderSnap = await db.ref(
    `zapupiOrders/${orderId}`
  ).get();

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

      if (
        gateway.status !== 'success' ||
        !gateway.payment_url
      ) {
        await orderRef.update({ status: 'failed' });

        return errorResponse(
          res,
          502,
          'ZapUPI payment link was not received'
        );
      }

      await orderRef.update({
        status: 'pending',
        paymentUrl: gateway.payment_url,
        txnId: gateway.txn_id || ''
      });

      res.json({
        status: 'success',
        order_id: orderId,
        payment_url: gateway.payment_url
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

      const snap = await db.ref(
        `zapupiOrders/${orderId}`
      ).get();

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

app.post('/api/zapupi/webhook', async (req, res) => {
  const orderId = String(req.body.order_id || '');

  if (!orderId) {
    return res.status(200).json({ status: 'ok' });
  }

  try {
    const snap = await db.ref(
      `zapupiOrders/${orderId}`
    ).get();

    if (snap.exists()) {
      await processOrder(orderId);
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
