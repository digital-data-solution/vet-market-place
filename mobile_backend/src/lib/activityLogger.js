import ActivityLog from '../models/ActivityLog.js';
import logger from './logger.js';

/**
 * Fire-and-forget activity logger. Never throws — callers are not required
 * to await or catch. Always returns a Promise so callers CAN await if needed.
 *
 * @param {string|ObjectId|null} userId  - MongoDB User._id (null for anon)
 * @param {string|null}          role    - User.role at time of action
 * @param {string}               action  - Dot-namespaced action key, e.g. 'user.login'
 * @param {Object}               meta    - Action-specific payload (no PII beyond IDs)
 * @param {Object|null}          req     - Express request — used to extract ip + userAgent
 */
export function logActivity(userId, role, action, meta = {}, req = null) {
  return ActivityLog.create({
    user:      userId  || null,
    userRole:  role    || null,
    action,
    metadata:  meta,
    ip:        req?.ip                          || null,
    userAgent: req?.headers?.['user-agent']     || null,
    timestamp: new Date(),
  }).catch(err => {
    // Non-fatal — never propagate logging failures to the main request
    logger.warn('logActivity failed (non-fatal)', { action, error: err.message });
  });
}
