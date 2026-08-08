// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: escrow dispute resolution.
//
// Buyer/provider self-service release/refund is blocked once a booking is
// disputed (see wallet.controller.js) — from that point on, only an admin
// (adminProtect, separate JWT from the app-user `protect` middleware) can
// move it to 'released' or 'refunded' using the same core mutations.
// ─────────────────────────────────────────────────────────────────────────────

import Booking from '../models/Booking.js';
import logger  from '../lib/logger.js';
import { doRelease, doRefund } from './wallet.controller.js';

export const listDisputes = async (req, res) => {
  try {
    const disputes = await Booking.find({ status: 'disputed' })
      .populate('buyer', 'name email phone')
      .populate('provider', 'name email phone')
      .populate('disputedBy', 'name email')
      .sort({ disputedAt: -1 })
      .lean();
    return res.json({ success: true, data: disputes });
  } catch (error) {
    logger.error('Admin list disputes error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load disputes.' });
  }
};

export const adminReleaseDispute = async (req, res) => {
  const bookingId = req.params.id;
  const note = (req.body.note || '').toString().trim().slice(0, 500);
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (booking.status !== 'disputed' && booking.status !== 'funded') {
      return res.status(400).json({ success: false, message: `Cannot resolve a booking that is "${booking.status}".` });
    }
    if (note) booking.adminNote = note;
    await doRelease(booking);
    logger.info('Admin resolved dispute — released to provider', { bookingId, admin: req.user?.email });
    return res.json({ success: true, message: 'Released to the provider.', data: { bookingId } });
  } catch (error) {
    logger.error('Admin release dispute error', { error: error.message, bookingId });
    return res.status(500).json({ success: false, message: 'Failed to release payment.' });
  }
};

export const adminRefundDispute = async (req, res) => {
  const bookingId = req.params.id;
  const note = (req.body.note || '').toString().trim().slice(0, 500);
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (booking.status !== 'disputed' && booking.status !== 'funded') {
      return res.status(400).json({ success: false, message: `Cannot resolve a booking that is "${booking.status}".` });
    }
    if (note) booking.adminNote = note;
    await doRefund(booking);
    logger.info('Admin resolved dispute — refunded to buyer', { bookingId, admin: req.user?.email });
    return res.json({ success: true, message: 'Refunded to the buyer.', data: { bookingId } });
  } catch (error) {
    logger.error('Admin refund dispute error', { error: error.message, bookingId });
    return res.status(500).json({ success: false, message: 'Failed to refund payment.' });
  }
};
