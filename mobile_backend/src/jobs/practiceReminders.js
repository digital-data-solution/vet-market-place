/**
 * Practice Records reminders — jobs/practiceReminders.js
 *
 * Daily scan for vaccinations/follow-ups due within 3 days. Two recipients
 * per due item:
 *   1. The vet — one digest email + one push, covering everything due.
 *   2. The client — one email per client per day (grouped, not one per pet),
 *      sent whether or not they're an Xpress Vet user, since vets add
 *      clients who've never signed up. This is OPT-IN, not opt-out: a
 *      client is only ever emailed if the vet explicitly flips
 *      Client.emailRemindersEnabled on for them (they own that consent,
 *      Xpress Vet doesn't impose it) — reminderOptOut is then a client-side
 *      safety valve on top of that.
 * If a client IS a linked platform user, they also get a push (reuses the
 * same infra as wallet notifications).
 *
 * Deliberately NOT built: any bulk/cold marketing send to the client list
 * captured here. The only outbound touch to a non-user client is this
 * transactional reminder, with an honest one-line mention of the app and an
 * unsubscribe link — see sendClientReminderEmail in email.service.js.
 */

import cron from 'node-cron';
import VaccinationRecord from '../models/VaccinationRecord.js';
import TreatmentRecord from '../models/TreatmentRecord.js';
import Client from '../models/Client.js';
import User from '../models/User.js';
import {
  sendPracticeReminderDigest,
  sendClientReminderEmail,
  clientReminderUnsubscribeUrl,
} from '../services/email.service.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import logger from '../lib/logger.js';

const REMINDER_WINDOW_DAYS = 3;
const MAX_ITEMS_PER_RUN = 500; // defensive cap, not expected to be hit early on

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function runPracticeReminders() {
  const now = new Date();
  const horizon = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [vaccinations, followUps] = await Promise.all([
    VaccinationRecord.find({ nextDueDate: { $gte: now, $lte: horizon }, reminderSentAt: null })
      .populate('patient', 'name species')
      .populate('client', 'name email emailRemindersEnabled reminderOptOut linkedUserId')
      .limit(MAX_ITEMS_PER_RUN)
      .lean(),
    TreatmentRecord.find({ followUpDate: { $gte: now, $lte: horizon }, followUpReminderSentAt: null })
      .populate('patient', 'name species')
      .populate('client', 'name email emailRemindersEnabled reminderOptOut linkedUserId')
      .limit(MAX_ITEMS_PER_RUN)
      .lean(),
  ]);

  if (!vaccinations.length && !followUps.length) {
    logger.info('Practice reminders: nothing due');
    return;
  }

  // Normalise both kinds into one shape, grouped by vet and by client.
  const byVet = new Map();    // vetId -> items[]
  const byClient = new Map(); // clientId -> { client, items[] }

  const addItem = (vetId, client, item) => {
    if (!byVet.has(vetId.toString())) byVet.set(vetId.toString(), []);
    byVet.get(vetId.toString()).push(item);

    // Opt-in, not opt-out: only email a client if the vet explicitly turned
    // this on for them, and the client hasn't since unsubscribed themselves.
    if (client?.email && client.emailRemindersEnabled && !client.reminderOptOut) {
      const cid = client._id.toString();
      if (!byClient.has(cid)) byClient.set(cid, { client, items: [] });
      byClient.get(cid).items.push(item);
    }
  };

  for (const v of vaccinations) {
    addItem(v.vet, v.client, {
      patientName: v.patient?.name || 'Patient',
      label: `${v.vaccineName} vaccination`,
      dueDateStr: fmtDate(v.nextDueDate),
    });
  }
  for (const f of followUps) {
    addItem(f.vet, f.client, {
      patientName: f.patient?.name || 'Patient',
      label: f.reason ? `Follow-up: ${f.reason}` : 'Follow-up visit',
      dueDateStr: fmtDate(f.followUpDate),
    });
  }

  // ── Vet digests + push ──────────────────────────────────────────────────
  let vetsSent = 0;
  for (const [vetId, items] of byVet) {
    const vet = await User.findById(vetId).select('name email pushToken').lean();
    if (!vet?.email) continue;
    sendPracticeReminderDigest(vet.name, vet.email, items).catch(() => {});
    sendPushToUser(vetId, '📋 Practice reminders', `${items.length} patient item${items.length === 1 ? ' is' : 's are'} due soon.`, { type: 'practice' }).catch(() => {});
    vetsSent++;
  }

  // ── Client emails + push (for linked users) ─────────────────────────────
  let clientsSent = 0;
  for (const [, { client, items }] of byClient) {
    // Need the vet's name for the "from Dr. X" framing — client.vet isn't
    // populated above, so look it up via the client record itself.
    const clientDoc = await Client.findById(client._id).populate('vet', 'name').lean();
    const vetName = clientDoc?.vet?.name;

    sendClientReminderEmail(client.name, client.email, vetName, items, clientReminderUnsubscribeUrl(client._id)).catch(() => {});
    if (client.linkedUserId) {
      sendPushToUser(
        client.linkedUserId,
        '🐾 Reminder for your pet',
        `${vetName || 'Your vet'}: ${items[0].patientName}'s ${items[0].label} is due ${items[0].dueDateStr}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}.`,
        { type: 'practice' },
      ).catch(() => {});
    }
    clientsSent++;
  }

  // ── Mark everything as reminded ─────────────────────────────────────────
  const sentAt = new Date();
  await Promise.all([
    VaccinationRecord.updateMany({ _id: { $in: vaccinations.map(v => v._id) } }, { $set: { reminderSentAt: sentAt } }),
    TreatmentRecord.updateMany({ _id: { $in: followUps.map(f => f._id) } }, { $set: { followUpReminderSentAt: sentAt } }),
  ]);

  logger.info(`Practice reminders: ${vaccinations.length} vaccination(s) + ${followUps.length} follow-up(s) due — notified ${vetsSent} vet(s), ${clientsSent} client(s)`);
}

export default function startPracticeReminderJob() {
  // Daily, 07:00 UTC (08:00 WAT) — before the vet's day starts.
  cron.schedule('0 7 * * *', async () => {
    try { await runPracticeReminders(); }
    catch (err) { logger.error('Practice reminders job error', { error: err.message }); }
  }, { timezone: 'UTC' });

  logger.info('⏰ Practice Records reminder job scheduled (daily 07:00 UTC)');
}
