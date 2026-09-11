/**
 * pitchOnePager.js — generates a real, live-data one-pager PDF for Sam to
 * hand out at in-person outreach (NVMA's Lagos chapter, clinic visits,
 * etc.) — see [[xpress-vet-marketing-next-steps]] for why this exists:
 * NVMA's own advice was "join the chapter and sell in person," which
 * needs a real leave-behind document, not another digital campaign.
 *
 * Pulls real numbers from the database at generation time rather than
 * hardcoding stats that go stale — same "verify against real state"
 * discipline as the rest of this pipeline. Deliberately does NOT claim
 * an "NVMA Verified" badge or any formal partnership — none exists yet
 * (Sam called the president 2026-09-10; the advice was to join and sell
 * in person, not a done partnership) — overclaiming here would be a real
 * credibility risk at exactly the in-person pitch this is meant to help.
 */
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { PLAN_TIERS, TIER_ORDER } from '../config/plans.js';

const BRAND_BLUE = '#2563EB';
const DARK = '#111827';
const GREY = '#6B7280';

function formatNGN(n) {
  if (n === null || n === undefined) return 'Custom pricing';
  if (n === 0) return 'Free';
  // NOT the ₦ symbol — pdfkit's built-in Helvetica (one of the 14 standard
  // PDF fonts, no custom font embedded here) doesn't include that glyph
  // and silently renders it as a broken box/pipe character. Caught by
  // actually reading the generated PDF, not assumed. "NGN" reads cleanly
  // in every PDF viewer with zero font-embedding complexity.
  return `NGN ${n.toLocaleString('en-NG')}/mo`;
}

/**
 * Generates the one-pager to `outputPath`. `stats` is real data the
 * caller pulls fresh from the DB — kept as a param (not queried inside
 * this module) so the module has no direct Mongoose dependency and can be
 * unit-tested/reused without a live DB connection.
 */
export function generatePitchOnePager(outputPath, stats) {
  const { vetCount, listingCount, sellerCount } = stats;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(fs.createWriteStream(outputPath));

  // Header
  doc.fillColor(BRAND_BLUE).fontSize(28).font('Helvetica-Bold').text('Xpress Vet', { continued: false });
  doc.fillColor(DARK).fontSize(14).font('Helvetica').text('Nigeria\'s marketplace for veterinary services, pets & livestock — built by a licensed vet, not just a tech company.');
  doc.moveDown(0.3);
  doc.fillColor(GREY).fontSize(10).text('Dr. Samuel Omale, Founder — DVM, Ahmadu Bello University Zaria, 2019');
  doc.moveDown(1);

  // Divider
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E5E7EB').stroke();
  doc.moveDown(1);

  // Real stats row — honest numbers, no invented social proof
  doc.fillColor(DARK).fontSize(16).font('Helvetica-Bold').text('Who\'s already here');
  doc.moveDown(0.3);
  doc.fontSize(11).font('Helvetica').fillColor(DARK).text(
    `${vetCount} veterinary professionals and farms already signed up. ${listingCount} active listings on the marketplace from ${sellerCount} sellers. Every listing gets a free auto-generated video ad — no design skill needed.`,
    { width: 495 },
  );
  doc.moveDown(1);

  // What members get
  doc.fontSize(16).font('Helvetica-Bold').text('What you get, free to start');
  doc.moveDown(0.3);
  const features = [
    'A professional listing discoverable by nearby pet owners and farmers',
    'Xpress Market — list products and animals for sale, buyers pay through in-app escrow for protection',
    'Practice Records — patient records, appointments, inventory, sized to your practice',
    'Job Board — post openings or find work at other practices',
    'Auto-generated video ads for every listing, posted across Instagram, Facebook, YouTube and TikTok on your behalf',
  ];
  doc.fontSize(11).font('Helvetica');
  features.forEach((f) => {
    doc.fillColor(BRAND_BLUE).text('•  ', { continued: true }).fillColor(DARK).text(f, { width: 480 });
  });
  doc.moveDown(1);

  // Pricing table — real numbers from config/plans.js, not invented
  doc.fontSize(16).font('Helvetica-Bold').text('Pricing — scales with your practice');
  doc.moveDown(0.4);
  const tableTop = doc.y;
  const colX = [50, 150, 260, 360, 460];
  const headers = ['Tier', 'Patients', 'Products', 'Staff seats', 'Price'];
  doc.fontSize(10).font('Helvetica-Bold').fillColor(GREY);
  headers.forEach((h, i) => doc.text(h, colX[i], tableTop, { width: colX[i + 1] ? colX[i + 1] - colX[i] : 90 }));
  doc.moveDown(0.5);
  let rowY = doc.y;
  doc.font('Helvetica').fillColor(DARK);
  TIER_ORDER.forEach((key) => {
    const t = PLAN_TIERS[key];
    doc.text(t.label, colX[0], rowY, { width: 90 });
    doc.text(t.maxPatients === Infinity ? 'Unlimited' : String(t.maxPatients), colX[1], rowY, { width: 90 });
    doc.text(t.maxProducts === Infinity ? 'Unlimited' : String(t.maxProducts), colX[2], rowY, { width: 90 });
    doc.text(t.maxSeats === Infinity ? 'Unlimited' : String(t.maxSeats), colX[3], rowY, { width: 90 });
    doc.text(formatNGN(t.priceNGN), colX[4], rowY, { width: 90 });
    rowY += 20;
  });
  doc.y = rowY + 10;
  doc.moveDown(1);

  // CTA / contact
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E5E7EB').stroke();
  doc.moveDown(1);
  doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_BLUE).text('Get started free today');
  doc.moveDown(0.2);
  doc.fontSize(11).font('Helvetica').fillColor(DARK).text('xpressvetmarketplace.com — sign up in under 2 minutes, no card required for the Free tier.');
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor(GREY).text('Questions? Talk to Dr. Samuel directly: contact@xpressdigitalanddatasolutions.online');

  doc.end();
  return outputPath;
}
