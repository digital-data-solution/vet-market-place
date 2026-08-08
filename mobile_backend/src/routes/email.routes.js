import express from 'express';
import { unsubscribe, clientUnsubscribe } from '../api/email.controller.js';

const router = express.Router();

// Public — no auth. Must work from a link clicked inside an email client.
router.get('/unsubscribe', unsubscribe);
router.get('/client-unsubscribe', clientUnsubscribe);

export default router;
