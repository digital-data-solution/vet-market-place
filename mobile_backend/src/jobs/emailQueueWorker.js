/**
 * Drains EmailQueue (models/EmailQueue.js) — the durable, dual-provider
 * outbound email queue. Runs every minute: claims due rows one at a time
 * (atomic findOneAndUpdate, so this stays correct even if ever scaled to
 * more than one instance), and for each one tries every configured
 * provider in order via processQueuedEmail() (services/email.service.js)
 * until one succeeds — that's the automatic Resend↔Brevo failover.
 *
 * A row only becomes permanently 'failed' after maxAttempts full passes,
 * each of which already tried every configured provider; a failed pass in
 * between just backs the row off (see nextBackoffAt in email.service.js)
 * and leaves it 'queued' for the next run to pick up again.
 *
 * EmailLog (the permanent, TTL'd audit trail + delivery-webhook
 * correlation record) is written here, once per row, at whichever
 * terminal state it reaches — not at enqueue time.
 */

import cron from 'node-cron';
import EmailQueue from '../models/EmailQueue.js';
import EmailLog from '../models/EmailLog.js';
import { processQueuedEmail, nextBackoffAt } from '../services/email.service.js';
import logger from '../lib/logger.js';

const BATCH_SIZE = 25; // cap per run so one minute's worth of mail can't monopolize the event loop

// Atomically claims the next due row, or null if none are due. Doing this
// one at a time (rather than find-many + bulk update) is what makes it
// safe against a second worker instance claiming the same row.
async function claimNext() {
  return EmailQueue.findOneAndUpdate(
    { status: 'queued', nextAttemptAt: { $lte: new Date() } },
    { $set: { status: 'processing' } },
    { sort: { nextAttemptAt: 1 }, new: true },
  );
}

async function processOne(doc) {
  const result = await processQueuedEmail(doc);

  if (result.ok) {
    doc.status = 'sent';
    doc.providerUsed = result.providerUsed;
    doc.resendEmailId = result.resendEmailId;
    doc.sentAt = new Date();
    await doc.save();
    EmailLog.create({
      to: doc.to, subject: doc.subject, status: 'sent',
      resendEmailId: result.resendEmailId,
    }).catch(() => {});
    return;
  }

  doc.attempts += 1;
  doc.lastAttemptErrors = result.attemptErrors;
  doc.lastError = result.attemptErrors.resend || result.attemptErrors.brevo || 'All configured providers failed';

  if (doc.attempts >= doc.maxAttempts) {
    doc.status = 'failed';
    await doc.save();
    logger.error('Email permanently failed after exhausting all providers/retries', {
      to: doc.to, subject: doc.subject, attempts: doc.attempts, errors: result.attemptErrors,
    });
    EmailLog.create({ to: doc.to, subject: doc.subject, status: 'failed', error: doc.lastError }).catch(() => {});
  } else {
    doc.status = 'queued';
    doc.nextAttemptAt = nextBackoffAt(doc.attempts);
    await doc.save();
  }
}

async function runSweep() {
  for (let i = 0; i < BATCH_SIZE; i++) {
    const doc = await claimNext();
    if (!doc) break; // nothing due — done for this run

    try {
      await processOne(doc);
    } catch (err) {
      // Something broke outside the expected send-failure path (e.g. a
      // save() error) — don't let it wedge the row in 'processing'
      // forever or crash the sweep for the rest of the batch.
      logger.error('Email queue item errored unexpectedly', { id: doc._id, error: err.message });
      try {
        doc.status = 'queued';
        doc.nextAttemptAt = new Date(Date.now() + 5 * 60 * 1000);
        await doc.save();
      } catch { /* give up on this row until the next natural sweep */ }
    }
  }
}

export default function startEmailQueueWorker() {
  cron.schedule('* * * * *', async () => {
    try {
      await runSweep();
    } catch (err) {
      logger.error('Email queue sweep error', { error: err.message });
    }
  }, { timezone: 'UTC' });

  logger.info('⏰ Email queue worker scheduled (every minute, Resend↔Brevo failover)');
}
