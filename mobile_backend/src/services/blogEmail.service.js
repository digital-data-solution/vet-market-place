/**
 * blogEmail.service.js — dispatches a published BlogPost as an email
 * campaign. Mirrors adminEmailCampaign.service.js's resolve/dispatch shape
 * exactly (same targetType: 'user'|'segment'|'all', same unconditional
 * marketingOptOut exclusion regardless of target — email keeps the stricter
 * consent bar than push everywhere in this codebase). Kept as its own
 * service rather than routed through AdminEmailCampaign because the send
 * state (status/recipientCount/etc.) is tracked directly on the BlogPost
 * document — one post, one "how did the last send go" answer, no separate
 * campaign row to cross-reference.
 */
import User from '../models/User.js';
import BlogPost from '../models/BlogPost.js';
import { resolveSegmentFilter } from './notificationSegments.service.js';
import { sendBlogPostEmail } from './email.service.js';
import logger from '../lib/logger.js';

export async function resolveBlogTargetFilter({ targetType, targetUserId, segmentKey }) {
  if (targetType === 'user') {
    if (!targetUserId) throw new Error('targetUserId is required for targetType "user".');
    return { _id: targetUserId };
  }
  if (targetType === 'segment') {
    const filter = await resolveSegmentFilter(segmentKey);
    if (!filter) throw new Error(`Unknown segment: ${segmentKey}`);
    return filter;
  }
  return {}; // 'all' — marketingOptOut enforced unconditionally below
}

export async function dispatchBlogPostEmail(postId, { targetType, targetUserId, segmentKey }) {
  const post = await BlogPost.findById(postId);
  if (!post) throw new Error('Post not found.');
  if (post.status !== 'published') throw new Error('Only a published post can be emailed.');

  post.emailStatus    = 'sending';
  post.emailTargetType = targetType;
  post.emailSegmentKey = targetType === 'segment' ? segmentKey : null;
  await post.save();

  try {
    const filter = await resolveBlogTargetFilter({ targetType, targetUserId, segmentKey });
    const recipients = await User.find({ ...filter, marketingOptOut: { $ne: true } })
      .select('name email')
      .lean();

    let queued = 0;
    for (const user of recipients) {
      if (!user.email) continue;
      try {
        await sendBlogPostEmail(user.name, user.email, user._id, post);
        queued++;
      } catch (err) {
        logger.error('Blog post email: send failed for one recipient', {
          postId: post._id, userId: user._id, error: err.message,
        });
      }
    }

    post.emailRecipientCount = recipients.length;
    post.emailSkippedCount   = recipients.length - queued;
    post.emailStatus         = 'sent';
    post.emailSentAt         = new Date();
    post.emailError          = null;
    await post.save();

    logger.info('Blog post email dispatched', {
      id: post._id, targetType, segmentKey, recipientCount: post.emailRecipientCount, queued,
    });
  } catch (err) {
    post.emailStatus = 'failed';
    post.emailError  = err.message;
    await post.save();
    logger.error('Blog post email dispatch failed', { id: postId, error: err.message });
  }

  return post;
}

export default { resolveBlogTargetFilter, dispatchBlogPostEmail };
