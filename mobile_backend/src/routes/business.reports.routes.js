import express from 'express';
import {
  getBusinessProfile,
  updateBusinessProfile,
  getReceipt,
  getDay,
  getDayCsv,
  closeDay,
  listDayCloses,
  getMonth,
  getMonthCsv,
} from '../api/business.reports.controller.js';
import businessAuth from '../middlewares/businessAuth.js';

const router = express.Router();

router.use(businessAuth);

// Receipt identity (logo/header/footer)
router.get('/business-profile', getBusinessProfile);
router.put('/business-profile', updateBusinessProfile);

// Receipt data for one sale
router.get('/receipt/:saleId', getReceipt);

// Daily transactions (view + CSV) — each calendar day, timezone-aware
router.get('/day',      getDay);
router.get('/day.csv',  getDayCsv);

// End-of-day close (Z report) with cash reconciliation
router.post('/close-day',  closeDay);
router.get('/day-closes',  listDayCloses);

// Monthly balancing
router.get('/month',     getMonth);
router.get('/month.csv', getMonthCsv);

export default router;
