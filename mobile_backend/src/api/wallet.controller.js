// ─────────────────────────────────────────────────────────────────────────────
// WALLET + ESCROW + COMMISSION  (Phase 2 monetization)
//
// Revenue model: buyers fund a wallet (Paystack), pay a provider into escrow,
// and on completion the platform releases funds to the provider MINUS a
// commission. Commission is the profit lever. Withdrawals use Paystack Transfers.
//
// All balance mutations run inside a mongoose transaction and use $inc so
// concurrent operations can never corrupt a balance.
// ─────────────────────────────────────────────────────────────────────────────

import axios       from 'axios';
import crypto      from 'crypto';
import mongoose    from 'mongoose';
import Wallet      from '../models/Wallet.js';
import Transaction from '../models/Transaction.js';
import Booking     from '../models/Booking.js';
import User        from '../models/User.js';
import Professional from '../models/Professional.js';
import Shop        from '../models/Shop.js';
import logger      from '../lib/logger.js';
import { logActivity } from '../lib/activityLogger.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import { sendEmail } from '../services/email.service.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

const COMMISSION_RATE = parseFloat(process.env.WALLET_COMMISSION_RATE || '0.10'); // 10%
const MIN_FUND        = 100;   // ₦
const MIN_WITHDRAW    = 500;   // ₦
const AUTO_RELEASE_DAYS = parseFloat(process.env.WALLET_AUTO_RELEASE_DAYS || '7');
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

function internalRef(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function getOrCreateWallet(userId, session) {
  const opts = session ? { session } : {};
  let wallet = await Wallet.findOne({ user: userId }, null, opts);
  if (!wallet) {
    const created = await Wallet.create([{ user: userId }], session ? { session } : undefined);
    wallet = created[0];
  }
  return wallet;
}

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────
export const getWallet = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const wallet = await getOrCreateWallet(userId);
    return res.json({
      success: true,
      data: {
        balance:       wallet.balance,
        escrowBalance: wallet.escrowBalance,
        currency:      wallet.currency,
      },
    });
  } catch (error) {
    logger.error('Get wallet error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to load wallet.' });
  }
};

export const getTransactions = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const limit  = Math.min(parseInt(req.query.limit || '30', 10), 100);
  try {
    const txns = await Transaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ success: true, data: txns });
  } catch (error) {
    logger.error('Get transactions error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to load transactions.' });
  }
};

export const getBookings = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const bookings = await Booking.find({ $or: [{ buyer: userId }, { provider: userId }] })
      .populate('buyer', 'name email')
      .populate('provider', 'name email')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const uid = userId.toString();
    const data = bookings.map(b => ({
      ...b,
      role: b.buyer?._id?.toString() === uid ? 'buyer' : 'provider',
    }));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('Get bookings error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to load bookings.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUND WALLET (Paystack)
// ─────────────────────────────────────────────────────────────────────────────
export const fundWallet = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const amount = parseInt(req.body.amount, 10);

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }
  if (!amount || amount < MIN_FUND) {
    return res.status(400).json({ success: false, message: `Minimum funding is ₦${MIN_FUND}.` });
  }

  try {
    const user = await User.findById(userId);
    if (!user)       return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.email) return res.status(400).json({ success: false, message: 'Account email required.' });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   amount * 100,
        currency: 'NGN',
        metadata: { type: 'wallet_fund', userId: userId.toString() },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;
    if (!data?.status || !data?.data) {
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    return res.status(201).json({
      success: true,
      message: 'Funding initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference:         data.data.reference,
        amount,
      },
    });
  } catch (error) {
    logger.error('Fund wallet error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to start funding.' });
  }
};

// Called by the Paystack webhook + verify fallback on a successful charge.
// Idempotent: a completed deposit with this reference is never applied twice.
export async function activateWalletFund(metadata, reference, amountKobo) {
  const userId = metadata.userId;
  if (!userId) throw new Error('wallet_fund metadata missing userId');

  const existing = await Transaction.findOne({ reference, type: 'deposit' });
  if (existing && existing.status === 'completed') {
    logger.info('Wallet fund already applied — skipping', { userId, reference });
    return { applied: false };
  }

  const amount = Math.round((amountKobo || 0) / 100);
  if (!amount || amount <= 0) throw new Error('wallet_fund invalid amount');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const wallet = await getOrCreateWallet(userId, session);
      await Wallet.updateOne({ _id: wallet._id }, { $inc: { balance: amount } }, { session });
      await Transaction.create([{
        wallet:   wallet._id,
        user:     userId,
        amount,
        type:     'deposit',
        status:   'completed',
        reference,
        metadata: { description: 'Wallet funding' },
      }], { session });
    });
  } finally {
    session.endSession();
  }

  logger.info('Wallet funded', { userId, amount, reference });
  logActivity(userId, null, 'wallet.funded', { amount, reference });
  return { applied: true, amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAY A PROVIDER INTO ESCROW (from wallet balance)
// Body: { providerId, amount, description }
// ─────────────────────────────────────────────────────────────────────────────
export const payProvider = async (req, res) => {
  const buyerId    = req.user._id || req.user.id;
  const providerId = req.body.providerId;
  const amount     = parseInt(req.body.amount, 10);
  const description = (req.body.description || '').toString().slice(0, 300);

  if (!providerId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'providerId and a positive amount are required.' });
  }
  if (providerId.toString() === buyerId.toString()) {
    return res.status(400).json({ success: false, message: 'You cannot pay yourself.' });
  }

  try {
    const provider = await User.findById(providerId);
    if (!provider) return res.status(404).json({ success: false, message: 'Provider not found.' });

    const [isProf, isShop] = await Promise.all([
      Professional.findOne({ userId: providerId }).lean(),
      Shop.findOne({ owner: providerId }).lean(),
    ]);
    if (!isProf && !isShop) {
      return res.status(400).json({ success: false, message: 'That user is not a registered provider.' });
    }

    const commissionAmount = Math.round(amount * COMMISSION_RATE);
    const providerAmount   = amount - commissionAmount;

    let bookingId;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const buyerWallet = await getOrCreateWallet(buyerId, session);
        if (buyerWallet.balance < amount) {
          throw new Error('INSUFFICIENT_FUNDS');
        }

        // Move buyer funds from balance -> escrow (earmarked, still buyer's until release)
        await Wallet.updateOne(
          { _id: buyerWallet._id },
          { $inc: { balance: -amount, escrowBalance: amount } },
          { session },
        );

        const now = new Date();
        const booking = await Booking.create([{
          buyer:    buyerId,
          provider: providerId,
          amount,
          commissionRate:   COMMISSION_RATE,
          commissionAmount,
          providerAmount,
          description,
          status:   'funded',
          fundedAt: now,
          // Protects the provider: if the buyer never taps Release, this
          // booking is auto-released by the cron job in jobs/walletJobs.js.
          autoReleaseAt: new Date(now.getTime() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000),
        }], { session });
        bookingId = booking[0]._id;

        await Transaction.create([{
          wallet:       buyerWallet._id,
          user:         buyerId,
          counterparty: providerId,
          amount,
          type:     'payment_escrow',
          status:   'completed',
          reference: internalRef('esc'),
          booking:  bookingId,
          metadata: { description: description || 'Payment held in escrow' },
        }], { session });
      });
    } finally {
      session.endSession();
    }

    logActivity(buyerId, req.user.role, 'wallet.escrow.funded', { providerId, amount, bookingId }, req);
    sendPushToUser(
      providerId,
      '💰 Payment Held in Escrow',
      `${req.user.name || 'A customer'} paid ₦${amount.toLocaleString()} for "${description || 'a service'}" — it's held safely and released to you once they confirm.`,
      { type: 'wallet', bookingId: String(bookingId) },
    ).catch(() => {});
    return res.status(201).json({
      success: true,
      message: 'Payment held in escrow. Release it once the service is completed.',
      data: { bookingId, amount, providerAmount, commissionAmount },
    });
  } catch (error) {
    if (error.message === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance. Fund your wallet first.' });
    }
    logger.error('Pay provider error', { error: error.message, buyerId });
    return res.status(500).json({ success: false, message: 'Failed to create escrow payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CORE MUTATIONS — shared by the buyer/provider routes below, the admin
// dispute-resolution endpoints (admin.wallet.controller.js), and the
// auto-release cron job (jobs/walletJobs.js). Callers are responsible for
// authorization and the "status must be funded/disputed" check.
// ─────────────────────────────────────────────────────────────────────────────

// Provider gets providerAmount, platform keeps commission.
export async function doRelease(booking, { auto = false } = {}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const buyerWallet    = await getOrCreateWallet(booking.buyer, session);
      const providerWallet = await getOrCreateWallet(booking.provider, session);

      await Wallet.updateOne({ _id: buyerWallet._id },    { $inc: { escrowBalance: -booking.amount } }, { session });
      await Wallet.updateOne({ _id: providerWallet._id }, { $inc: { balance: booking.providerAmount } }, { session });

      await Transaction.create([
        {
          wallet: providerWallet._id, user: booking.provider, counterparty: booking.buyer,
          amount: booking.providerAmount, type: 'payment_release', status: 'completed',
          reference: internalRef('rel'), booking: booking._id,
          metadata: { description: auto ? 'Escrow auto-released to provider' : 'Escrow released to provider' },
        },
        {
          user: null, counterparty: booking.provider,
          amount: booking.commissionAmount, type: 'commission', status: 'completed',
          reference: internalRef('com'), booking: booking._id,
          metadata: { description: `Platform commission (${Math.round(booking.commissionRate * 100)}%)` },
        },
      ], { session });

      booking.status     = 'released';
      booking.releasedAt = new Date();
      await booking.save({ session });
    });
  } finally {
    session.endSession();
  }

  sendPushToUser(
    booking.provider,
    '🎉 Payment Released',
    `You've received ₦${booking.providerAmount.toLocaleString()} (after ${Math.round(booking.commissionRate * 100)}% platform fee).`,
    { type: 'wallet', bookingId: String(booking._id) },
  ).catch(() => {});
  if (auto) {
    sendPushToUser(
      booking.buyer,
      'Payment Auto-Released',
      `Your ₦${booking.amount.toLocaleString()} payment was automatically released to the provider after ${AUTO_RELEASE_DAYS} days. Contact Support if there was an issue.`,
      { type: 'wallet', bookingId: String(booking._id) },
    ).catch(() => {});
  }
}

// Buyer gets the full amount back.
export async function doRefund(booking) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const buyerWallet = await getOrCreateWallet(booking.buyer, session);
      await Wallet.updateOne(
        { _id: buyerWallet._id },
        { $inc: { escrowBalance: -booking.amount, balance: booking.amount } },
        { session },
      );
      await Transaction.create([{
        wallet: buyerWallet._id, user: booking.buyer, counterparty: booking.provider,
        amount: booking.amount, type: 'refund', status: 'completed',
        reference: internalRef('ref'), booking: booking._id,
        metadata: { description: 'Escrow refunded to buyer' },
      }], { session });

      booking.status     = 'refunded';
      booking.refundedAt = new Date();
      await booking.save({ session });
    });
  } finally {
    session.endSession();
  }

  sendPushToUser(
    booking.buyer,
    '💸 Payment Refunded',
    `Your ₦${booking.amount.toLocaleString()} payment was refunded to your wallet balance.`,
    { type: 'wallet', bookingId: String(booking._id) },
  ).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE ESCROW → buyer confirms the service was done. Buyer-only; once
// disputed, only an admin can move the booking (see admin.wallet.controller.js).
// ─────────────────────────────────────────────────────────────────────────────
export const releaseEscrow = async (req, res) => {
  const userId    = req.user._id || req.user.id;
  const bookingId = req.params.id;

  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (booking.buyer.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Only the buyer can release this payment.' });
    }
    if (booking.status !== 'funded') {
      return res.status(400).json({
        success: false,
        message: booking.status === 'disputed'
          ? 'This payment is under dispute review and can no longer be released directly.'
          : `Cannot release a booking that is "${booking.status}".`,
      });
    }

    await doRelease(booking);

    logActivity(userId, req.user.role, 'wallet.escrow.released', {
      bookingId, providerAmount: booking.providerAmount, commission: booking.commissionAmount,
    }, req);
    return res.json({ success: true, message: 'Payment released to the provider.', data: { bookingId } });
  } catch (error) {
    logger.error('Release escrow error', { error: error.message, bookingId });
    return res.status(500).json({ success: false, message: 'Failed to release payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REFUND ESCROW → provider voluntarily gives the money back. Provider-only;
// once disputed, only an admin can move the booking.
// ─────────────────────────────────────────────────────────────────────────────
export const refundEscrow = async (req, res) => {
  const userId    = req.user._id || req.user.id;
  const bookingId = req.params.id;

  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (booking.provider.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Only the provider can refund this payment.' });
    }
    if (booking.status !== 'funded') {
      return res.status(400).json({
        success: false,
        message: booking.status === 'disputed'
          ? 'This payment is under dispute review and can no longer be refunded directly.'
          : `Cannot refund a booking that is "${booking.status}".`,
      });
    }

    await doRefund(booking);

    logActivity(userId, req.user.role, 'wallet.escrow.refunded', { bookingId, amount: booking.amount }, req);
    return res.json({ success: true, message: 'Payment refunded to the buyer.', data: { bookingId } });
  } catch (error) {
    logger.error('Refund escrow error', { error: error.message, bookingId });
    return res.status(500).json({ success: false, message: 'Failed to refund payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DISPUTE ESCROW → buyer reports a problem instead of releasing. Freezes the
// booking (neither side can self-serve release/refund anymore) and alerts
// an admin by email to resolve it manually via the admin dashboard.
// ─────────────────────────────────────────────────────────────────────────────
export const disputeBooking = async (req, res) => {
  const userId    = req.user._id || req.user.id;
  const bookingId = req.params.id;
  const reason    = (req.body.reason || '').toString().trim().slice(0, 500);

  if (!reason || reason.length < 10) {
    return res.status(400).json({ success: false, message: 'Please describe the issue (at least 10 characters).' });
  }

  try {
    const booking = await Booking.findById(bookingId).populate('buyer', 'name email').populate('provider', 'name email');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (booking.buyer._id.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Only the buyer can dispute this payment.' });
    }
    if (booking.status !== 'funded') {
      return res.status(400).json({ success: false, message: `Cannot dispute a booking that is "${booking.status}".` });
    }

    booking.status        = 'disputed';
    booking.disputeReason = reason;
    booking.disputedAt    = new Date();
    booking.disputedBy    = userId;
    await booking.save();

    logActivity(userId, req.user.role, 'wallet.escrow.disputed', { bookingId, reason }, req);

    sendEmail(
      ADMIN_EMAIL,
      `⚠️ Escrow dispute — ₦${booking.amount.toLocaleString()} held`,
      `<p><strong>${booking.buyer?.name || 'A buyer'}</strong> (${booking.buyer?.email || 'no email'}) disputed a payment to
       <strong>${booking.provider?.name || 'a provider'}</strong> (${booking.provider?.email || 'no email'}).</p>
       <p><strong>Amount:</strong> ₦${booking.amount.toLocaleString()}<br/>
       <strong>Booking ID:</strong> ${booking._id}<br/>
       <strong>Reason:</strong> ${reason}</p>
       <p>Resolve it from the admin dashboard → Escrow Disputes.</p>`,
    ).catch((err) => logger.error('Dispute admin email failed', { error: err.message }));

    return res.json({
      success: true,
      message: "We've frozen this payment and notified our team. We'll resolve it shortly.",
      data: { bookingId },
    });
  } catch (error) {
    logger.error('Dispute escrow error', { error: error.message, bookingId });
    return res.status(500).json({ success: false, message: 'Failed to file dispute.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAW (Paystack Transfer). Debits only after Paystack accepts the transfer.
// Body: { amount, bankCode, accountNumber, accountName }
// ─────────────────────────────────────────────────────────────────────────────
export const getBanks = async (_req, res) => {
  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  try {
    const r = await axios.get(`${PAYSTACK_BASE}/bank?currency=NGN`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
    });
    const banks = (r.data?.data || []).map(b => ({ name: b.name, code: b.code }));
    return res.json({ success: true, data: banks });
  } catch (error) {
    logger.error('Get banks error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load bank list.' });
  }
};

// Resolve a bank account to its registered name before the user commits to
// a withdrawal, so a typo'd account number is caught before money moves.
export const resolveAccount = async (req, res) => {
  const bankCode      = (req.query.bankCode || '').toString().trim();
  const accountNumber = (req.query.accountNumber || '').toString().trim();

  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  if (!bankCode || accountNumber.length !== 10) {
    return res.status(400).json({ success: false, message: 'A bank and a 10-digit account number are required.' });
  }

  try {
    const r = await axios.get(`${PAYSTACK_BASE}/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
    });
    const accountName = r.data?.data?.account_name;
    if (!accountName) return res.status(400).json({ success: false, message: 'Could not verify this account.' });
    return res.json({ success: true, data: { accountName } });
  } catch (error) {
    const paystackMsg = error.response?.data?.message;
    logger.error('Resolve account error', { error: error.message, paystackMsg });
    return res.status(400).json({ success: false, message: paystackMsg || 'Could not verify this account. Check the details.' });
  }
};

export const requestWithdrawal = async (req, res) => {
  const userId        = req.user._id || req.user.id;
  const amount        = parseInt(req.body.amount, 10);
  const bankCode      = (req.body.bankCode || '').toString().trim();
  const accountNumber = (req.body.accountNumber || '').toString().trim();
  const accountName   = (req.body.accountName || '').toString().trim() || (req.user.name || 'Xpress Vet user');

  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  if (!amount || amount < MIN_WITHDRAW) {
    return res.status(400).json({ success: false, message: `Minimum withdrawal is ₦${MIN_WITHDRAW}.` });
  }
  if (!bankCode || !accountNumber) {
    return res.status(400).json({ success: false, message: 'Bank and account number are required.' });
  }

  try {
    const wallet = await getOrCreateWallet(userId);
    if (wallet.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance.' });
    }

    // 1) Create (or reuse) a Paystack transfer recipient
    const recipRes = await axios.post(
      `${PAYSTACK_BASE}/transferrecipient`,
      { type: 'nuban', name: accountName, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );
    const recipientCode = recipRes.data?.data?.recipient_code;
    if (!recipientCode) {
      return res.status(400).json({ success: false, message: 'Could not verify bank account. Check the details.' });
    }

    // 2) Initiate the transfer
    const reference = internalRef('wd');
    const transferRes = await axios.post(
      `${PAYSTACK_BASE}/transfer`,
      { source: 'balance', amount: amount * 100, recipient: recipientCode, reason: 'Xpress Vet wallet withdrawal', reference },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );
    if (!transferRes.data?.status) {
      return res.status(400).json({ success: false, message: transferRes.data?.message || 'Transfer failed.' });
    }

    // 3) Hold the funds (debit balance) and record a pending withdrawal.
    //    transfer.success / transfer.failed webhook finalises it.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Wallet.updateOne({ _id: wallet._id }, { $inc: { balance: -amount } }, { session });
        await Transaction.create([{
          wallet: wallet._id, user: userId, amount, type: 'withdrawal', status: 'pending',
          reference, metadata: { description: `Withdrawal to ${accountNumber}` },
        }], { session });
      });
    } finally {
      session.endSession();
    }

    logActivity(userId, req.user.role, 'wallet.withdrawal.requested', { amount, reference }, req);
    return res.status(201).json({
      success: true,
      message: 'Withdrawal is being processed. You will receive the funds shortly.',
      data: { amount, reference, status: transferRes.data?.data?.status || 'pending' },
    });
  } catch (error) {
    const paystackMsg = error.response?.data?.message;
    logger.error('Withdrawal error', { error: error.message, paystackMsg, userId });
    return res.status(400).json({
      success: false,
      message: paystackMsg || 'Withdrawal failed. Transfers may not be enabled on the payment account yet.',
    });
  }
};

// Called by the webhook on transfer.success / transfer.failed / transfer.reversed.
export async function handleTransferEvent(eventName, data) {
  const reference = data?.reference;
  if (!reference) return;

  const txn = await Transaction.findOne({ reference, type: 'withdrawal' });
  if (!txn) { logger.warn('Transfer event for unknown withdrawal', { reference }); return; }
  if (txn.status !== 'pending') return; // already finalised

  if (eventName === 'transfer.success') {
    txn.status = 'completed';
    await txn.save();
    logger.info('Withdrawal completed', { reference });
    sendPushToUser(
      txn.user,
      '✅ Withdrawal Successful',
      `₦${txn.amount.toLocaleString()} has been sent to your bank account.`,
      { type: 'wallet' },
    ).catch(() => {});
  } else if (eventName === 'transfer.failed' || eventName === 'transfer.reversed') {
    // Refund the held amount back to the wallet.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Wallet.updateOne({ _id: txn.wallet }, { $inc: { balance: txn.amount } }, { session });
        txn.status = 'failed';
        await txn.save({ session });
      });
    } finally {
      session.endSession();
    }
    logger.info('Withdrawal reversed — balance restored', { reference });
    sendPushToUser(
      txn.user,
      '⚠️ Withdrawal Failed',
      `Your ₦${txn.amount.toLocaleString()} withdrawal could not be completed and has been returned to your wallet balance.`,
      { type: 'wallet' },
    ).catch(() => {});
  }
}
