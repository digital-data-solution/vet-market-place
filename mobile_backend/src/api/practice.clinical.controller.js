// ─────────────────────────────────────────────────────────────────────────────
// PRACTICE — CLINICAL EXTENSIONS: hospitalization (wards / inpatient stays),
// surgery records, and grooming records. Built on top of Practice Records:
// same tenant (the vet/clinic owner), same dual auth (owner Supabase token OR
// scoped staff token via businessAuth), same requireVet() gate + attribution.
//
// For clinics that do more than out-patient visits — they keep animals for days
// (hospitalization), operate (surgery), and groom. Every write is stamped with
// the acting person's name (createdByName) for hospital-flow accountability.
// ─────────────────────────────────────────────────────────────────────────────
import Patient from '../models/Patient.js';
import Hospitalization from '../models/Hospitalization.js';
import SurgeryRecord from '../models/SurgeryRecord.js';
import GroomingRecord from '../models/GroomingRecord.js';
import ClinicalProcedure from '../models/ClinicalProcedure.js';
import { requireVet } from './practice.controller.js';
import logger from '../lib/logger.js';

// Confirm the patient belongs to this clinic (tenant isolation). Returns the
// patient doc or null (after sending 404).
async function patientOf(ctx, patientId, res) {
  const patient = await Patient.findOne({ _id: patientId, vet: ctx.userId });
  if (!patient) { res.status(404).json({ success: false, message: 'Patient not found.' }); return null; }
  return patient;
}

// ── HOSPITALIZATION (wards) ──────────────────────────────────────────────────

// GET /hospitalizations?status=&patientId=  — the ward board (defaults to admitted)
export const listHospitalizations = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const filter = { vet: ctx.userId };
    if (req.query.status && ['admitted', 'discharged'].includes(req.query.status)) filter.status = req.query.status;
    else if (!req.query.patientId) filter.status = 'admitted'; // default view = currently in the ward
    if (req.query.patientId) filter.patient = req.query.patientId;
    const stays = await Hospitalization.find(filter)
      .populate('patient', 'name species breed photo')
      .populate('client', 'name phone')
      .sort({ admittedAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data: stays });
  } catch (error) {
    logger.error('listHospitalizations error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load hospitalizations.' });
  }
};

// POST /patients/:patientId/hospitalizations  — admit a patient to the ward
export const admitPatient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const patient = await patientOf(ctx, req.params.patientId, res);
    if (!patient) return;
    const stay = await Hospitalization.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      reason: req.body.reason || null, ward: req.body.ward || null,
      admittedAt: req.body.admittedAt ? new Date(req.body.admittedAt) : new Date(),
      estimatedCost: req.body.estimatedCost !== undefined ? Number(req.body.estimatedCost) : null,
      status: 'admitted',
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: stay });
  } catch (error) {
    logger.error('admitPatient error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to admit patient.' });
  }
};

// POST /hospitalizations/:id/logs  — add a daily care log to a stay
export const addHospitalizationLog = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const stay = await Hospitalization.findOne({ _id: req.params.id, vet: ctx.userId });
    if (!stay) return res.status(404).json({ success: false, message: 'Hospitalization not found.' });
    stay.dailyLogs.push({
      at: req.body.at ? new Date(req.body.at) : new Date(),
      note: req.body.note || null,
      temperature: req.body.temperature !== undefined ? Number(req.body.temperature) : undefined,
      weightKg: req.body.weightKg !== undefined ? Number(req.body.weightKg) : undefined,
      medication: req.body.medication || null,
      feeding: req.body.feeding || null,
      byName: ctx.actorName,
    });
    await stay.save();
    res.status(201).json({ success: true, data: stay });
  } catch (error) {
    logger.error('addHospitalizationLog error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to add the care log.' });
  }
};

// PUT /hospitalizations/:id  — edit stay details (reason, ward, estimatedCost)
export const updateHospitalization = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const set = {};
    for (const k of ['reason', 'ward', 'dischargeSummary']) if (req.body[k] !== undefined) set[k] = req.body[k];
    if (req.body.estimatedCost !== undefined) set.estimatedCost = Number(req.body.estimatedCost);
    const stay = await Hospitalization.findOneAndUpdate({ _id: req.params.id, vet: ctx.userId }, { $set: set }, { new: true });
    if (!stay) return res.status(404).json({ success: false, message: 'Hospitalization not found.' });
    res.json({ success: true, data: stay });
  } catch (error) {
    logger.error('updateHospitalization error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update the stay.' });
  }
};

// POST /hospitalizations/:id/discharge  — discharge the patient
export const dischargePatient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const stay = await Hospitalization.findOneAndUpdate(
      { _id: req.params.id, vet: ctx.userId, status: 'admitted' },
      { $set: {
        status: 'discharged',
        dischargedAt: req.body.dischargedAt ? new Date(req.body.dischargedAt) : new Date(),
        dischargeSummary: req.body.dischargeSummary || null,
        dischargedByName: ctx.actorName,
      } },
      { new: true },
    );
    if (!stay) return res.status(404).json({ success: false, message: 'Active hospitalization not found.' });
    res.json({ success: true, data: stay });
  } catch (error) {
    logger.error('dischargePatient error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to discharge.' });
  }
};

// DELETE /hospitalizations/:id
export const deleteHospitalization = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const del = await Hospitalization.findOneAndDelete({ _id: req.params.id, vet: ctx.userId });
    if (!del) return res.status(404).json({ success: false, message: 'Hospitalization not found.' });
    res.json({ success: true, message: 'Deleted.' });
  } catch (error) {
    logger.error('deleteHospitalization error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete.' });
  }
};

// ── SURGERY ──────────────────────────────────────────────────────────────────

// POST /patients/:patientId/surgeries
export const createSurgery = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const patient = await patientOf(ctx, req.params.patientId, res);
    if (!patient) return;
    if (!req.body.procedure) return res.status(400).json({ success: false, message: 'Procedure is required.' });
    const rec = await SurgeryRecord.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      procedure: req.body.procedure,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      surgeon: req.body.surgeon || ctx.actorName,
      anaesthesia: req.body.anaesthesia || null,
      durationMins: req.body.durationMins !== undefined ? Number(req.body.durationMins) : undefined,
      findings: req.body.findings || null,
      outcome: req.body.outcome || 'successful',
      notes: req.body.notes || null,
      followUpDate: req.body.followUpDate ? new Date(req.body.followUpDate) : null,
      cost: req.body.cost !== undefined ? Number(req.body.cost) : null,
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: rec });
  } catch (error) {
    logger.error('createSurgery error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to save the surgery record.' });
  }
};

export const updateSurgery = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const set = {};
    for (const k of ['procedure', 'surgeon', 'anaesthesia', 'findings', 'outcome', 'notes']) if (req.body[k] !== undefined) set[k] = req.body[k];
    if (req.body.date !== undefined) set.date = new Date(req.body.date);
    if (req.body.durationMins !== undefined) set.durationMins = Number(req.body.durationMins);
    if (req.body.followUpDate !== undefined) set.followUpDate = req.body.followUpDate ? new Date(req.body.followUpDate) : null;
    if (req.body.cost !== undefined) set.cost = Number(req.body.cost);
    const rec = await SurgeryRecord.findOneAndUpdate({ _id: req.params.id, vet: ctx.userId }, { $set: set }, { new: true });
    if (!rec) return res.status(404).json({ success: false, message: 'Surgery record not found.' });
    res.json({ success: true, data: rec });
  } catch (error) {
    logger.error('updateSurgery error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update the surgery record.' });
  }
};

export const deleteSurgery = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const del = await SurgeryRecord.findOneAndDelete({ _id: req.params.id, vet: ctx.userId });
    if (!del) return res.status(404).json({ success: false, message: 'Surgery record not found.' });
    res.json({ success: true, message: 'Deleted.' });
  } catch (error) {
    logger.error('deleteSurgery error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete.' });
  }
};

// ── GROOMING ─────────────────────────────────────────────────────────────────

// POST /patients/:patientId/grooming
export const createGrooming = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const patient = await patientOf(ctx, req.params.patientId, res);
    if (!patient) return;
    if (!req.body.service) return res.status(400).json({ success: false, message: 'Grooming service is required.' });
    const rec = await GroomingRecord.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      service: req.body.service,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      groomer: req.body.groomer || ctx.actorName,
      products: req.body.products || null,
      notes: req.body.notes || null,
      price: req.body.price !== undefined ? Number(req.body.price) : null,
      nextDueDate: req.body.nextDueDate ? new Date(req.body.nextDueDate) : null,
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: rec });
  } catch (error) {
    logger.error('createGrooming error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to save the grooming record.' });
  }
};

export const updateGrooming = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const set = {};
    for (const k of ['service', 'groomer', 'products', 'notes']) if (req.body[k] !== undefined) set[k] = req.body[k];
    if (req.body.date !== undefined) set.date = new Date(req.body.date);
    if (req.body.price !== undefined) set.price = Number(req.body.price);
    if (req.body.nextDueDate !== undefined) set.nextDueDate = req.body.nextDueDate ? new Date(req.body.nextDueDate) : null;
    const rec = await GroomingRecord.findOneAndUpdate({ _id: req.params.id, vet: ctx.userId }, { $set: set }, { new: true });
    if (!rec) return res.status(404).json({ success: false, message: 'Grooming record not found.' });
    res.json({ success: true, data: rec });
  } catch (error) {
    logger.error('updateGrooming error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update the grooming record.' });
  }
};

export const deleteGrooming = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const del = await GroomingRecord.findOneAndDelete({ _id: req.params.id, vet: ctx.userId });
    if (!del) return res.status(404).json({ success: false, message: 'Grooming record not found.' });
    res.json({ success: true, message: 'Deleted.' });
  } catch (error) {
    logger.error('deleteGrooming error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete.' });
  }
};

// ── CLINICAL PROCEDURES (broad catch-all: imaging, dental, deworming, etc.) ──

// POST /patients/:patientId/procedures
export const createProcedure = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const patient = await patientOf(ctx, req.params.patientId, res);
    if (!patient) return;
    if (!req.body.category) return res.status(400).json({ success: false, message: 'Category is required.' });
    const rec = await ClinicalProcedure.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      category: req.body.category,
      title: req.body.title || null,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      performedBy: req.body.performedBy || ctx.actorName,
      findings: req.body.findings || null,
      notes: req.body.notes || null,
      resultImageUrl: req.body.resultImageUrl || null,
      cost: req.body.cost !== undefined ? Number(req.body.cost) : null,
      followUpDate: req.body.followUpDate ? new Date(req.body.followUpDate) : null,
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: rec });
  } catch (error) {
    logger.error('createProcedure error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to save the procedure.' });
  }
};

export const updateProcedure = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const set = {};
    for (const k of ['category', 'title', 'performedBy', 'findings', 'notes', 'resultImageUrl']) if (req.body[k] !== undefined) set[k] = req.body[k];
    if (req.body.date !== undefined) set.date = new Date(req.body.date);
    if (req.body.cost !== undefined) set.cost = Number(req.body.cost);
    if (req.body.followUpDate !== undefined) set.followUpDate = req.body.followUpDate ? new Date(req.body.followUpDate) : null;
    const rec = await ClinicalProcedure.findOneAndUpdate({ _id: req.params.id, vet: ctx.userId }, { $set: set }, { new: true });
    if (!rec) return res.status(404).json({ success: false, message: 'Procedure not found.' });
    res.json({ success: true, data: rec });
  } catch (error) {
    logger.error('updateProcedure error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update the procedure.' });
  }
};

export const deleteProcedure = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const del = await ClinicalProcedure.findOneAndDelete({ _id: req.params.id, vet: ctx.userId });
    if (!del) return res.status(404).json({ success: false, message: 'Procedure not found.' });
    res.json({ success: true, message: 'Deleted.' });
  } catch (error) {
    logger.error('deleteProcedure error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete.' });
  }
};

// GET /patients/:patientId/clinical — every clinical record type for one patient,
// so the patient screen can show hospitalizations, surgeries, grooming and the
// broad procedures (imaging, dental, etc.) in one place.
export const getPatientClinical = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const patient = await patientOf(ctx, req.params.patientId, res);
    if (!patient) return;
    const [hospitalizations, surgeries, grooming, procedures] = await Promise.all([
      Hospitalization.find({ vet: ctx.userId, patient: patient._id }).sort({ admittedAt: -1 }).limit(50).lean(),
      SurgeryRecord.find({ vet: ctx.userId, patient: patient._id }).sort({ date: -1 }).limit(50).lean(),
      GroomingRecord.find({ vet: ctx.userId, patient: patient._id }).sort({ date: -1 }).limit(50).lean(),
      ClinicalProcedure.find({ vet: ctx.userId, patient: patient._id }).sort({ date: -1 }).limit(50).lean(),
    ]);
    res.json({ success: true, data: { hospitalizations, surgeries, grooming, procedures } });
  } catch (error) {
    logger.error('getPatientClinical error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load clinical records.' });
  }
};
