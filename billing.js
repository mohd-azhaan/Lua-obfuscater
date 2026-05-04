// src/routes/billing.js  –  /subscribe, /webhook, /billing-portal
'use strict';

const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db      = require('../db');
const { requireJWT }      = require('../middleware/auth');
const { webhookLimiter }  = require('../middleware/rateLimiter');
const logger              = require('../utils/logger');

const router = express.Router();

// ── POST /subscribe  (create or update Stripe subscription) ─────
router.post('/subscribe', requireJWT, async (req, res) => {
  const { plan } = req.body;

  if (!['basic'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Available: basic' });
  }

  const priceId = process.env.STRIPE_BASIC_PRICE_ID;
  if (!priceId) {
    return res.status(500).json({ error: 'Billing not configured' });
  }

  const userId = req.user.id;

  try {
    // Fetch full user row to get Stripe IDs
    const { rows } = await db.query(
      'SELECT email, stripe_customer_id, stripe_sub_id FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];

    // ── Ensure Stripe customer exists ────────────────────────────
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    user.email,
        metadata: { userId },
      });
      customerId = customer.id;
      await db.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, userId]
      );
    }

    // ── If already subscribed, return existing session ───────────
    if (user.stripe_sub_id) {
      const existingSub = await stripe.subscriptions.retrieve(user.stripe_sub_id);
      if (['active', 'trialing'].includes(existingSub.status)) {
        return res.json({
          message: 'Already subscribed',
          status: existingSub.status,
        });
      }
    }

    // ── Create Stripe Checkout Session (hosted page) ─────────────
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      mode:                 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata:             { userId, plan },
      success_url: `${req.headers.origin || 'https://yourdomain.com'}/dashboard?subscribed=true`,
      cancel_url:  `${req.headers.origin || 'https://yourdomain.com'}/pricing`,
      subscription_data: {
        metadata: { userId, plan },
      },
    });

    logger.info('Checkout session created', { userId, plan });
    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    logger.error('Subscribe error', { error: err.message, userId });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── POST /billing-portal  (manage existing subscription) ────────
router.post('/billing-portal', requireJWT, async (req, res) => {
  const { rows } = await db.query(
    'SELECT stripe_customer_id FROM users WHERE id = $1',
    [req.user.id]
  );
  const customerId = rows[0]?.stripe_customer_id;

  if (!customerId) {
    return res.status(400).json({ error: 'No billing account found' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${req.headers.origin || 'https://yourdomain.com'}/dashboard`,
    });
    res.json({ portal_url: session.url });
  } catch (err) {
    logger.error('Billing portal error', { error: err.message });
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ── POST /webhook  (Stripe webhook – raw body required) ─────────
// NOTE: Express body-parser is bypassed for this route (see server.js)
router.post(
  '/webhook',
  webhookLimiter,
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig     = req.headers['stripe-signature'];
    const secret  = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      logger.warn('Webhook signature verification failed', { error: err.message });
      return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    // ── Idempotency guard ────────────────────────────────────────
    try {
      await db.query(
        'INSERT INTO webhook_events (stripe_event_id) VALUES ($1)',
        [event.id]
      );
    } catch (err) {
      if (err.code === '23505') {
        // Duplicate – already processed
        logger.info('Duplicate webhook, skipping', { eventId: event.id });
        return res.json({ received: true });
      }
      throw err;
    }

    // ── Handle events ────────────────────────────────────────────
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;

        case 'invoice.paid':
          await handleInvoicePaid(event.data.object);
          break;

        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object);
          break;

        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object);
          break;

        default:
          logger.debug('Unhandled webhook event', { type: event.type });
      }
    } catch (err) {
      logger.error('Webhook handler error', { eventId: event.id, error: err.message });
      // Return 500 so Stripe retries
      return res.status(500).json({ error: 'Webhook processing failed' });
    }

    res.json({ received: true });
  }
);

// ── Webhook handlers ─────────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  const { userId, plan } = session.metadata || {};
  if (!userId || !plan) return;

  const subId    = session.subscription;
  const sub      = await stripe.subscriptions.retrieve(subId);
  const expiryTs = new Date(sub.current_period_end * 1000);

  await db.query(
    `UPDATE users
       SET plan            = $1,
           plan_expires_at = $2,
           stripe_sub_id   = $3,
           sub_status      = 'active'
     WHERE id = $4`,
    [plan, expiryTs, subId, userId]
  );

  logger.info('Subscription activated via checkout', { userId, plan, expiryTs });
}

async function handleInvoicePaid(invoice) {
  // Renew plan expiry on each successful payment
  const subId = invoice.subscription;
  if (!subId) return;

  const sub    = await stripe.subscriptions.retrieve(subId);
  const userId = sub.metadata?.userId;
  if (!userId) return;

  const expiryTs = new Date(sub.current_period_end * 1000);

  await db.query(
    `UPDATE users
       SET plan_expires_at = $1, sub_status = 'active'
     WHERE stripe_sub_id = $2`,
    [expiryTs, subId]
  );

  logger.info('Invoice paid – plan renewed', { userId, expiryTs });
}

async function handlePaymentFailed(invoice) {
  const subId = invoice.subscription;
  if (!subId) return;

  await db.query(
    `UPDATE users SET sub_status = 'past_due' WHERE stripe_sub_id = $1`,
    [subId]
  );

  logger.warn('Payment failed', { subId });
  // TODO: send email notification to user
}

async function handleSubscriptionDeleted(sub) {
  await db.query(
    `UPDATE users
       SET plan            = 'free',
           plan_expires_at = NULL,
           stripe_sub_id   = NULL,
           sub_status      = 'canceled'
     WHERE stripe_sub_id = $1`,
    [sub.id]
  );
  logger.info('Subscription canceled', { subId: sub.id });
}

async function handleSubscriptionUpdated(sub) {
  const expiryTs = new Date(sub.current_period_end * 1000);
  await db.query(
    `UPDATE users
       SET sub_status      = $1,
           plan_expires_at = $2
     WHERE stripe_sub_id   = $3`,
    [sub.status, expiryTs, sub.id]
  );
}

module.exports = router;
