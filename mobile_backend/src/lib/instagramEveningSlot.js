/**
 * One Instagram post per Nigerian evening, enforced in Mongo rather than by
 * "did anything post in the last 10 h?" alone. Since 2026-10-14 the Reels
 * workers run in two places at once — node-cron on the always-on Render
 * server (on time) and GitHub Actions (backup, fires hours late) — and two
 * sweeps a few seconds apart could both pass the 10 h check before either
 * has posted. Inserting a document keyed by the WAT date is atomic: the
 * second sweep gets a duplicate-key error and stands down.
 *
 * A sweep that ends up posting nothing (nothing due, or Instagram refused
 * it) gives the slot back so a later run that evening can try again.
 */
import mongoose from 'mongoose';

const slots = () => mongoose.connection.collection('instagramslots');

// Nigeria = UTC+1, no DST.
const watDate = (now = new Date()) => new Date(now.getTime() + 3600e3).toISOString().slice(0, 10);

/** @returns {Promise<string|null>} the slot key if this sweep may post tonight, null if another sweep has it */
export async function claimEveningSlot(worker) {
  const key = watDate();
  try {
    await slots().insertOne({ _id: key, worker, claimedAt: new Date() });
    return key;
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
}

export async function releaseEveningSlot(key) {
  if (key) await slots().deleteOne({ _id: key });
}
