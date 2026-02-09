import express from 'express';
import { onboardProfessional } from '../api/professional.controller.js';

const router = express.Router();

router.post('/onboard', onboardProfessional);

export default router;
