/**
 * adminEmailCampaign.service.js
 *
 * Resolves an AdminEmailCampaign's target (single user / segment / everyone)
 * to a concrete recipient list and queues one email per recipient via
 * services/email.service.js's sendEmail (which itself writes to EmailQueue —
 * jobs/emailQueueWorker.js does the actual provider send/failover a minute
 * or two later). Mirrors adminNotification.service.js's dispatch shape.
 *
 * Unlike push (marketingOptOut only applied when a segment is flagged
 * `marketing: true` — see notificationSegments.service.js), email ALWAYS
 * excludes marketingOptOut users regardless of segment, since email carries
 * stricter consent expectations (NDPR/CAN-SPAM) than an in-app push does.
 */

import User from '../models/User.js';
import AdminEmailCampaign from '../models/AdminEmailCampaign.js';
import { resolveSegmentFilter } from './notificationSegments.service.js';
import { sendAdminCampaignEmail } from './email.service.js';
import logger from '../lib/logger.js';

export async function resolveEmailTargetFilter(campaign) {
  if (campaign.targetType === 'user') {
    if (!campaign.targetUserId) throw new Error('targetUserId is required for targetType "user".');
    return { _id: campaign.targetUserId };
  }
  if (campaign.targetType === 'segment') {
    const filter = await resolveSegmentFilter(campaign.segmentKey);
    if (!filter) throw new Error(`Unknown segment: ${campaign.segmentKey}`);
    return filter;
  }
  return {}; // 'all' — marketingOptOut is enforced unconditionally below regardless of target type
}

export async function dispatchAdminEmailCampaign(campaignId) {
  const campaign = await AdminEmailCampaign.findById(campaignId);
  if (!campaign || ['sent', 'failed'].includes(campaign.status)) return campaign;

  try {
    const filter = await resolveEmailTargetFilter(campaign);
    const recipients = await User.find({ ...filter, marketingOptOut: { $ne: true } })
      .select('name email')
      .lean();

    let queued = 0;
    for (const user of recipients) {
      if (!user.email) continue;
      try {
        await sendAdminCampaignEmail(user.name, user.email, user._id, campaign.subject, campaign.body);
        queued++;
      } catch (err) {
        logger.error('Admin email campaign: send failed for one recipient', {
          campaignId: campaign._id, userId: user._id, error: err.message,
        });
      }
    }

    campaign.recipientCount = recipients.length;
    campaign.skippedCount   = recipients.length - queued;
    campaign.status         = 'sent';
    campaign.sentAt         = new Date();
    await campaign.save();

    logger.info('Admin email campaign dispatched', {
      id: campaign._id,
      targetType: campaign.targetType,
      segmentKey: campaign.segmentKey,
      recipientCount: campaign.recipientCount,
      queued,
    });
  } catch (err) {
    campaign.status = 'failed';
    campaign.error  = err.message;
    await campaign.save();
    logger.error('Admin email campaign dispatch failed', { id: campaignId, error: err.message });
  }

  return campaign;
}

export default { resolveEmailTargetFilter, dispatchAdminEmailCampaign };
