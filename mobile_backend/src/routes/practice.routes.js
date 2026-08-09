import express from 'express';
import {
  getPracticePricing,
  getPracticeStatus,
  createPracticePayment,
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listPatients,
  createPatient,
  getPatient,
  updatePatient,
  deletePatient,
  createTreatment,
  updateTreatment,
  deleteTreatment,
  createVaccination,
  updateVaccination,
  deleteVaccination,
  createLabResult,
  updateLabResult,
  deleteLabResult,
  getDueSoon,
} from '../api/practice.controller.js';
import businessAuth from '../middlewares/businessAuth.js';

const router = express.Router();

router.get('/pricing', getPracticePricing); // public — safe to show unauthenticated

// Dual-mode: the vet owner's Supabase token OR a scoped staff token (reception,
// vet, lab tech). The controller (requireVet) resolves the tenant + permissions.
router.use(businessAuth);

router.get('/status', getPracticeStatus);
router.post('/pay',    createPracticePayment);
router.get('/due-soon', getDueSoon);

router.get('/clients',      listClients);
router.post('/clients',     createClient);
router.put('/clients/:id',    updateClient);
router.delete('/clients/:id', deleteClient);

router.get('/patients',       listPatients);
router.post('/patients',      createPatient);
router.get('/patients/:id',   getPatient);
router.put('/patients/:id',    updatePatient);
router.delete('/patients/:id', deletePatient);

router.post('/patients/:patientId/treatments', createTreatment);
router.put('/treatments/:id',    updateTreatment);
router.delete('/treatments/:id', deleteTreatment);

router.post('/patients/:patientId/vaccinations', createVaccination);
router.put('/vaccinations/:id',    updateVaccination);
router.delete('/vaccinations/:id', deleteVaccination);

router.post('/patients/:patientId/lab', createLabResult);
router.put('/lab/:id',    updateLabResult);
router.delete('/lab/:id', deleteLabResult);

export default router;
