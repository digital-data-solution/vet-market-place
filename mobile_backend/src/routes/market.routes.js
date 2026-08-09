import express from 'express';
import {
  getMarketMeta,
  browseListings,
  getListing,
  myListings,
  createListing,
  updateListing,
  markSold,
  renewListing,
  deleteListing,
  reportListing,
  createListingBoostPayment,
  buyListing,
} from '../api/market.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// ─── Public (no auth) ─────────────────────────────────────────────────────────
router.get('/meta', getMarketMeta);
router.get('/', browseListings);

// ─── Authenticated ──────────────────────────────────────────────────────────
// NOTE: /mine must be registered before /:id so it isn't captured as an id.
router.get('/mine', protect, myListings);

router.post('/', protect, createListing);
router.put('/:id', protect, updateListing);
router.post('/:id/sold', protect, markSold);
router.post('/:id/renew', protect, renewListing);
router.delete('/:id', protect, deleteListing);
router.post('/:id/report', protect, reportListing);
router.post('/:id/boost', protect, createListingBoostPayment);
router.post('/:id/buy', protect, buyListing);

// Public single-listing view — LAST so the specific routes above win.
router.get('/:id', getListing);

export default router;
