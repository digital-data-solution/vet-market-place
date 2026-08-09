// ─────────────────────────────────────────────────────────────────────────────
// PRACTICE RECORDS — the "virtual clinic" add-on for vets.
//
// Clients (pet owners) -> Patients (animals) -> TreatmentRecords / VaccinationRecords.
// Free tier: up to PRACTICE_FREE_PATIENT_LIMIT active patients. Paying unlocks
// unlimited patients via the same one-off-extend Paystack pattern as
// featured.controller.js (practiceAddon.activeUntil on the Professional doc).
// Reminders (jobs/practiceReminders.js) work identically on both tiers — the
// only gate is how many patients you can add.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import Professional from '../models/Professional.js';
import Client from '../models/Client.js';
import Patient from '../models/Patient.js';
import TreatmentRecord from '../models/TreatmentRecord.js';
import VaccinationRecord from '../models/VaccinationRecord.js';
import LabResult from '../models/LabResult.js';
import User from '../models/User.js';
import logger from '../lib/logger.js';
import { resolveTier, nextTier } from '../config/plans.js';
import { logActivity } from '../lib/activityLogger.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const FREE_PATIENT_LIMIT = parseInt(process.env.PRACTICE_FREE_PATIENT_LIMIT || '5', 10);

// Priced as an add-on, below the Pro subscription tier (₦5,000/mo) since it
// stacks on top of an existing listing rather than replacing it.
// Exported so admin.stats.controller.js can turn 'practice.activated'
// ActivityLog entries (which store `days`, not `amount`) back into revenue.
export const PRACTICE_PACKAGES = {
  30:  { days: 30,  price: 3000,  label: '1 Month' },
  90:  { days: 90,  price: 8000,  label: '3 Months' },
  365: { days: 365, price: 28000, label: '12 Months' },
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function resolveVet(userId) {
  const professional = await Professional.findOne({ userId, role: 'vet' });
  return professional;
}

function isAddonActive(professional) {
  const until = professional?.practiceAddon?.activeUntil;
  return !!(until && new Date(until) > new Date());
}

// Practice/hospital-flow staff permissions (StaffMember.permissions).
const PRACTICE_PERMS = ['reception', 'clinical', 'lab'];

// Resolve the clinic (vet) tenant + the acting person, for BOTH:
//   • the vet owner (Supabase token via businessAuth → req.user/req.businessOwnerId), and
//   • a staff member (scoped staff token → req.staffActor), e.g. reception, lab tech.
// The tenant is always the vet owner, so all records stay under the vet. Options:
//   perm      — staff must hold this permission (owner always passes)
//   ownerOnly — staff are refused (billing/limits are the owner's call)
// Returns { userId (vet tenant), professional, staff, actorName, isOwner } or null.
async function requireVet(req, res, { perm = null, ownerOnly = false } = {}) {
  const ownerId = req.businessOwnerId || req.user?._id || req.user?.id;
  if (!ownerId) { res.status(401).json({ success: false, message: 'Not authorized.' }); return null; }

  const professional = await resolveVet(ownerId);
  if (!professional) {
    res.status(403).json({ success: false, message: 'Practice Records is available to registered veterinarians only.' });
    return null;
  }

  const staff = req.staffActor || null;
  if (staff) {
    if (ownerOnly) { res.status(403).json({ success: false, message: 'Only the clinic owner can do this.' }); return null; }
    const perms = staff.permissions || {};
    if (perm) {
      if (!perms[perm]) { res.status(403).json({ success: false, message: "You don't have permission for this step. Ask the clinic owner." }); return null; }
    } else if (!PRACTICE_PERMS.some((p) => perms[p])) {
      res.status(403).json({ success: false, message: 'You do not have access to clinic records.' }); return null;
    }
  }

  // Enterprise hold: block NEW records (any write has a `perm`) when a whale's
  // usage has outgrown their plan — reads stay open so no data is lost.
  if (perm) {
    const owner = await User.findById(ownerId).select('enterpriseHold').lean();
    if (owner?.enterpriseHold?.active) {
      res.status(402).json({ success: false, code: 'ENTERPRISE_REQUIRED',
        message: owner.enterpriseHold.reason || 'Your usage has grown beyond this plan. Please contact us to move to an Enterprise plan and continue.' });
      return null;
    }
  }

  const actorName = staff?.name || professional?.name || 'Owner';
  return { userId: String(ownerId), professional, staff, actorName, isOwner: !staff };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS / PRICING / PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
export const getPracticePricing = async (_req, res) => {
  res.json({
    success: true,
    data: {
      currency: 'NGN',
      freePatientLimit: FREE_PATIENT_LIMIT,
      packages: Object.values(PRACTICE_PACKAGES),
      benefits: [
        `Free up to ${FREE_PATIENT_LIMIT} patients — clients, treatment history, vaccination schedules`,
        'Clinic plan: up to 300 patients',
        'Automatic email + push reminders for upcoming vaccinations and follow-ups',
        'Running a large clinic or hospital? Contact us for the Hospital or Enterprise plan',
      ],
    },
  });
};

export const getPracticeStatus = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const patientCount = await Patient.countDocuments({ vet: ctx.userId, isActive: true });
    const active = isAddonActive(ctx.professional);
    const until = ctx.professional.practiceAddon?.activeUntil;
    const owner = await User.findById(ctx.userId).select('plan businessAddon');
    const tier = resolveTier(owner, active);
    res.json({
      success: true,
      data: {
        patientCount,
        freePatientLimit: FREE_PATIENT_LIMIT,
        planTier: tier.key,
        planLabel: tier.label,
        maxPatients: tier.maxPatients === Infinity ? null : tier.maxPatients,
        atLimit: patientCount >= tier.maxPatients,
        addonActive: active,
        activeUntil: active ? until : null,
        daysRemaining: active ? Math.ceil((new Date(until) - new Date()) / (1000 * 60 * 60 * 24)) : 0,
      },
    });
  } catch (error) {
    logger.error('Get practice status error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load status.' });
  }
};

export const createPracticePayment = async (req, res) => {
  const ctx = await requireVet(req, res, { ownerOnly: true });
  if (!ctx) return;
  const days = parseInt(req.body.days, 10);
  const pkg = PRACTICE_PACKAGES[days];

  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  if (!pkg) return res.status(400).json({ success: false, message: 'Invalid package. Choose 30, 90 or 365 days.' });

  try {
    const user = await User.findById(ctx.userId);
    if (!user)       return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.email) return res.status(400).json({ success: false, message: 'Account email required to pay.' });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   pkg.price * 100,
        currency: 'NGN',
        metadata: { type: 'practice_addon', professionalId: ctx.professional._id.toString(), days: pkg.days, userId: ctx.userId.toString() },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;
    if (!data?.status || !data?.data) return res.status(500).json({ success: false, message: 'Payment initialization failed.' });

    logActivity(ctx.userId, user.role, 'practice.initiated', { days: pkg.days, amount: pkg.price }, req);
    res.status(201).json({
      success: true,
      message: 'Practice Records payment initialized.',
      data: { authorization_url: data.data.authorization_url, reference: data.data.reference, amount: pkg.price, days: pkg.days },
    });
  } catch (error) {
    logger.error('Create practice payment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to start payment.' });
  }
};

// Called by the Paystack webhook + verify fallback. Idempotent per reference,
// mirrors activateFeatured's "extend from later of now/existing" logic.
export async function activatePracticeAddon(metadata, reference) {
  const { professionalId, days } = metadata;
  const addonDays = PRACTICE_PACKAGES[days]?.days ?? parseInt(days, 10);
  if (!professionalId || !addonDays) throw new Error('practice_addon metadata incomplete');

  const professional = await Professional.findById(professionalId);
  if (!professional) throw new Error('Practice addon target not found');

  if (professional.practiceAddon?.lastPaymentReference === reference) {
    logger.info('Practice addon already applied for reference — skipping', { professionalId, reference });
    return { activeUntil: professional.practiceAddon.activeUntil, days: addonDays };
  }

  const now  = new Date();
  const base = professional.practiceAddon?.activeUntil && professional.practiceAddon.activeUntil > now
    ? professional.practiceAddon.activeUntil : now;
  const activeUntil = new Date(base.getTime() + addonDays * 24 * 60 * 60 * 1000);

  professional.practiceAddon = { activeUntil, lastPaymentReference: reference };
  await professional.save();

  logger.info('Practice addon activated', { professionalId, days: addonDays, activeUntil, reference });
  logActivity(professional.userId, null, 'practice.activated', { days: addonDays, activeUntil, reference });

  return { activeUntil, days: addonDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────────────────────
export const listClients = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const q = (req.query.q || '').trim();
    const filter = { vet: ctx.userId };
    if (q) filter.$text = { $search: q };
    const clients = await Client.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, data: clients });
  } catch (error) {
    logger.error('List clients error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load clients.' });
  }
};

export const createClient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'reception' });
  if (!ctx) return;
  const { name, phone, email, address, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Client name is required.' });

  try {
    // Auto-link if a platform user matches this phone or email.
    let linkedUserId = null;
    if (email || phone) {
      const match = await User.findOne({ $or: [
        email ? { email: email.toLowerCase().trim() } : null,
        phone ? { phone: phone.trim() } : null,
      ].filter(Boolean) }).select('_id');
      if (match) linkedUserId = match._id;
    }

    const client = await Client.create({
      vet: ctx.userId, name: name.trim(), phone, email, address, notes, linkedUserId,
      emailRemindersEnabled: req.body.emailRemindersEnabled === true,
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: client });
  } catch (error) {
    logger.error('Create client error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create client.' });
  }
};

export const updateClient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'reception' });
  if (!ctx) return;
  try {
    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, vet: ctx.userId },
      { $set: pick(req.body, ['name', 'phone', 'email', 'address', 'notes', 'emailRemindersEnabled']) },
      { new: true },
    );
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
    res.json({ success: true, data: client });
  } catch (error) {
    logger.error('Update client error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update client.' });
  }
};

export const deleteClient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'reception' });
  if (!ctx) return;
  try {
    const patientCount = await Patient.countDocuments({ vet: ctx.userId, client: req.params.id });
    if (patientCount > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete a client with patients on file. Delete their patients first.' });
    }
    const result = await Client.deleteOne({ _id: req.params.id, vet: ctx.userId });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Client not found.' });
    res.json({ success: true, message: 'Client deleted.' });
  } catch (error) {
    logger.error('Delete client error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete client.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATIENTS
// ─────────────────────────────────────────────────────────────────────────────
export const listPatients = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const filter = { vet: ctx.userId, isActive: true };
    if (req.query.clientId) filter.client = req.query.clientId;
    const patients = await Patient.find(filter).populate('client', 'name phone').sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, data: patients });
  } catch (error) {
    logger.error('List patients error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load patients.' });
  }
};

export const createPatient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'reception' });
  if (!ctx) return;
  const { clientId, name } = req.body;
  if (!clientId || !name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'clientId and patient name are required.' });
  }

  try {
    const client = await Client.findOne({ _id: clientId, vet: ctx.userId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

    // Tier-based patient cap (scales solo vet → hospital). Legacy add-on holders
    // map to the Clinic tier for backward compatibility.
    const owner = await User.findById(ctx.userId).select('plan businessAddon');
    const tier = resolveTier(owner, isAddonActive(ctx.professional));
    const count = await Patient.countDocuments({ vet: ctx.userId, isActive: true });
    if (count >= tier.maxPatients) {
      const nt = nextTier(tier.key);
      return res.status(402).json({
        success: false,
        code: 'UPGRADE_REQUIRED',
        tier: tier.key, nextTier: nt.key,
        message: `Your ${tier.label} plan allows ${tier.maxPatients} patients. Upgrade to ${nt.label} to add more — contact us to upgrade.`,
      });
    }

    const patient = await Patient.create({
      vet: ctx.userId,
      client: clientId,
      ...pick(req.body, ['name', 'species', 'breed', 'sex', 'dob', 'weightKg', 'color', 'microchipId', 'photo', 'notes']),
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: patient });
  } catch (error) {
    logger.error('Create patient error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create patient.' });
  }
};

export const getPatient = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const patient = await Patient.findOne({ _id: req.params.id, vet: ctx.userId }).populate('client', 'name phone email').lean();
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });

    const [treatments, vaccinations, labResults] = await Promise.all([
      TreatmentRecord.find({ patient: patient._id, vet: ctx.userId }).sort({ date: -1 }).lean(),
      VaccinationRecord.find({ patient: patient._id, vet: ctx.userId }).sort({ dateGiven: -1 }).lean(),
      LabResult.find({ patient: patient._id, vet: ctx.userId }).sort({ performedAt: -1 }).lean(),
    ]);

    res.json({ success: true, data: { ...patient, treatments, vaccinations, labResults } });
  } catch (error) {
    logger.error('Get patient error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load patient.' });
  }
};

export const updatePatient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'reception' });
  if (!ctx) return;
  try {
    const patient = await Patient.findOneAndUpdate(
      { _id: req.params.id, vet: ctx.userId },
      { $set: pick(req.body, ['name', 'species', 'breed', 'sex', 'dob', 'weightKg', 'color', 'microchipId', 'photo', 'notes', 'isActive']) },
      { new: true },
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });
    res.json({ success: true, data: patient });
  } catch (error) {
    logger.error('Update patient error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update patient.' });
  }
};

export const deletePatient = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'reception' });
  if (!ctx) return;
  try {
    const patient = await Patient.findOne({ _id: req.params.id, vet: ctx.userId });
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });

    await Promise.all([
      TreatmentRecord.deleteMany({ patient: patient._id, vet: ctx.userId }),
      VaccinationRecord.deleteMany({ patient: patient._id, vet: ctx.userId }),
      LabResult.deleteMany({ patient: patient._id, vet: ctx.userId }),
      Patient.deleteOne({ _id: patient._id }),
    ]);
    res.json({ success: true, message: 'Patient and their records deleted.' });
  } catch (error) {
    logger.error('Delete patient error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete patient.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TREATMENT RECORDS
// ─────────────────────────────────────────────────────────────────────────────
export const createTreatment = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const patient = await Patient.findOne({ _id: req.params.patientId, vet: ctx.userId });
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });

    const record = await TreatmentRecord.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      ...pick(req.body, ['date', 'reason', 'diagnosis', 'treatment', 'medications', 'weightKg', 'notes', 'followUpDate']),
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: record });
  } catch (error) {
    logger.error('Create treatment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create treatment record.' });
  }
};

export const updateTreatment = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const record = await TreatmentRecord.findOneAndUpdate(
      { _id: req.params.id, vet: ctx.userId },
      { $set: pick(req.body, ['date', 'reason', 'diagnosis', 'treatment', 'medications', 'weightKg', 'notes', 'followUpDate']) },
      { new: true },
    );
    if (!record) return res.status(404).json({ success: false, message: 'Treatment record not found.' });
    res.json({ success: true, data: record });
  } catch (error) {
    logger.error('Update treatment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update treatment record.' });
  }
};

export const deleteTreatment = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const result = await TreatmentRecord.deleteOne({ _id: req.params.id, vet: ctx.userId });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Treatment record not found.' });
    res.json({ success: true, message: 'Treatment record deleted.' });
  } catch (error) {
    logger.error('Delete treatment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete treatment record.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LAB RESULTS — for clinics that run their own laboratory. Attach report file
// (PDF/photo) via the existing /api/upload endpoint, store its URL here.
// ─────────────────────────────────────────────────────────────────────────────
const LAB_FIELDS = ['testName', 'sampleType', 'results', 'referenceRange', 'status', 'performedAt', 'technicianName', 'attachmentUrl', 'notes'];

export const createLabResult = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'lab' });
  if (!ctx) return;
  if (!req.body.testName || !req.body.testName.trim()) return res.status(400).json({ success: false, message: 'Test name is required.' });
  try {
    const patient = await Patient.findOne({ _id: req.params.patientId, vet: ctx.userId });
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });
    const record = await LabResult.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      ...pick(req.body, LAB_FIELDS),
      createdByName: ctx.actorName,
      // Auto-fill the uploader from the logged-in person if not typed in.
      technicianName: (req.body.technicianName && req.body.technicianName.trim()) || ctx.actorName,
    });
    res.status(201).json({ success: true, data: record });
  } catch (error) {
    logger.error('Create lab result error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to save lab result.' });
  }
};

export const updateLabResult = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'lab' });
  if (!ctx) return;
  try {
    const record = await LabResult.findOneAndUpdate(
      { _id: req.params.id, vet: ctx.userId },
      { $set: pick(req.body, LAB_FIELDS) },
      { new: true },
    );
    if (!record) return res.status(404).json({ success: false, message: 'Lab result not found.' });
    res.json({ success: true, data: record });
  } catch (error) {
    logger.error('Update lab result error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update lab result.' });
  }
};

export const deleteLabResult = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'lab' });
  if (!ctx) return;
  try {
    const result = await LabResult.deleteOne({ _id: req.params.id, vet: ctx.userId });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Lab result not found.' });
    res.json({ success: true, message: 'Lab result deleted.' });
  } catch (error) {
    logger.error('Delete lab result error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete lab result.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// VACCINATION RECORDS
// ─────────────────────────────────────────────────────────────────────────────
export const createVaccination = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  const { vaccineName } = req.body;
  if (!vaccineName || !vaccineName.trim()) return res.status(400).json({ success: false, message: 'Vaccine name is required.' });

  try {
    const patient = await Patient.findOne({ _id: req.params.patientId, vet: ctx.userId });
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });

    const record = await VaccinationRecord.create({
      vet: ctx.userId, patient: patient._id, client: patient.client,
      ...pick(req.body, ['vaccineName', 'dateGiven', 'nextDueDate', 'notes']),
      createdByName: ctx.actorName,
    });
    res.status(201).json({ success: true, data: record });
  } catch (error) {
    logger.error('Create vaccination error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create vaccination record.' });
  }
};

export const updateVaccination = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const record = await VaccinationRecord.findOneAndUpdate(
      { _id: req.params.id, vet: ctx.userId },
      { $set: pick(req.body, ['vaccineName', 'dateGiven', 'nextDueDate', 'notes']) },
      { new: true },
    );
    if (!record) return res.status(404).json({ success: false, message: 'Vaccination record not found.' });
    res.json({ success: true, data: record });
  } catch (error) {
    logger.error('Update vaccination error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update vaccination record.' });
  }
};

export const deleteVaccination = async (req, res) => {
  const ctx = await requireVet(req, res, { perm: 'clinical' });
  if (!ctx) return;
  try {
    const result = await VaccinationRecord.deleteOne({ _id: req.params.id, vet: ctx.userId });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Vaccination record not found.' });
    res.json({ success: true, message: 'Vaccination record deleted.' });
  } catch (error) {
    logger.error('Delete vaccination error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete vaccination record.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DUE SOON — dashboard feed of upcoming vaccinations + follow-ups
// ─────────────────────────────────────────────────────────────────────────────
export const getDueSoon = async (req, res) => {
  const ctx = await requireVet(req, res);
  if (!ctx) return;
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const [vaccinations, followUps] = await Promise.all([
      VaccinationRecord.find({ vet: ctx.userId, nextDueDate: { $gte: now, $lte: horizon } })
        .populate('patient', 'name species').sort({ nextDueDate: 1 }).lean(),
      TreatmentRecord.find({ vet: ctx.userId, followUpDate: { $gte: now, $lte: horizon } })
        .populate('patient', 'name species').sort({ followUpDate: 1 }).lean(),
    ]);

    res.json({ success: true, data: { vaccinations, followUps } });
  } catch (error) {
    logger.error('Get due-soon error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load upcoming items.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
