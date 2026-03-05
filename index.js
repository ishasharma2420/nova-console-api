const express = require('express');
const axios = require('axios');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const MAVIS_BASE = 'https://mavis-rest-us11.leadsquared.com/api';
const MAVIS_DB = process.env.MAVIS_DB_ID;
const MAVIS_KEY = process.env.MAVIS_API_KEY;
const MAVIS_ORG = process.env.MAVIS_ORG_CODE || '78807';

const LSQ_BASE = 'https://api-us11.leadsquared.com/v2';
const LSQ_KEY = process.env.LSQ_API_KEY;
const LSQ_SECRET = process.env.LSQ_API_SECRET;

const APPOINTMENTS_TABLE = process.env.MAVIS_APPOINTMENTS_TABLE;
const SLOTS_TABLE = process.env.MAVIS_SLOTS_TABLE;
const WAITLIST_TABLE = process.env.MAVIS_WAITLIST_TABLE;

// ─── MAVIS HELPERS ────────────────────────────────────────────────────────────

async function mavisQuery(table, search = [], pageSize = 500) {
  const url = `${MAVIS_BASE}/${MAVIS_DB}/${table}/rows/query?orgcode=${MAVIS_ORG}`;
  const res = await axios.post(
    url,
    { Search: search, Paging: { PageIndex: 1, PageSize: pageSize } },
    { headers: { 'x-api-key': MAVIS_KEY, 'Content-Type': 'application/json' } }
  );
  return res.data?.Data || [];
}

async function mavisUpdate(table, rowId, updates) {
  // Build ColumnId/ColumnValue pairs
  const columnData = Object.entries(updates).map(([key, value]) => ({
    ColumnId: key,
    ColumnValue: value === null || value === undefined ? '' : String(value),
  }));
  const url = `${MAVIS_BASE}/${MAVIS_DB}/${table}/rows?orgcode=${MAVIS_ORG}`;
  const res = await axios.put(
    url,
    { RowId: rowId, Data: columnData },
    { headers: { 'x-api-key': MAVIS_KEY, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ─── LSQ HELPERS ──────────────────────────────────────────────────────────────

async function lsqUpdateLead(prospectId, fields) {
  const body = [{ Attribute: 'ProspectID', Value: prospectId }];
  for (const [key, value] of Object.entries(fields)) {
    body.push({ Attribute: key, Value: value });
  }
  await axios.post(
    `${LSQ_BASE}/LeadManagement.svc/Lead.UpdateByEmailAddress`,
    body,
    { params: { accessKey: LSQ_KEY, secretKey: LSQ_SECRET } }
  );
}

// ─── RISK SCORING ─────────────────────────────────────────────────────────────

function calcRiskScore(appt) {
  let score = 0;
  const priorNoShows = parseInt(appt.prior_no_shows) || 0;
  const priorCancellations = parseInt(appt.prior_cancellations) || 0;
  const daysBooked = parseInt(appt.days_booked_in_advance) || 0;
  const slotType = appt.slot_type || '';
  const insurance = appt.insurance_type || '';
  const serviceLine = appt.service_line || '';

  // Prior history
  score += Math.min(priorNoShows * 15, 35);
  score += Math.min(priorCancellations * 7, 14);

  // Booking advance
  score += daysBooked > 18 ? 10 : daysBooked > 10 ? 5 : 0;

  // Slot type
  score += slotType === 'Evening' ? 10 : slotType === 'Afternoon' ? 4 : 0;

  // Insurance
  const insuranceBias = { Private: 0, Medicare: 3, Medicaid: 9, Others: 11 };
  score += insuranceBias[insurance] || 0;

  // Service line
  const serviceLineBias = {
    'Mental Health': 10, 'ABA Therapy': 9, 'Pain Management': 4,
    'Dermatology': 3, 'IVF & Fertility': 4, 'Primary Care': 5, 'Orthopaedics': 3
  };
  score += serviceLineBias[serviceLine] || 0;

  // Noise
  score += Math.floor(Math.random() * 8) - 4;

  return Math.min(Math.max(Math.round(score), 3), 97);
}

function getRiskBand(score) {
  if (score >= 65) return 'High';
  if (score >= 35) return 'Medium';
  return 'Low';
}

function buildContributingFactors(appt) {
  const factors = [];
  const priorNoShows = parseInt(appt.prior_no_shows) || 0;
  const daysBooked = parseInt(appt.days_booked_in_advance) || 0;

  if (priorNoShows >= 2) factors.push(`${priorNoShows} prior no-shows`);
  else if (priorNoShows === 1) factors.push('1 prior no-show');
  if (daysBooked > 18) factors.push(`${daysBooked} days advance booking`);
  if (appt.slot_type === 'Evening') factors.push('Evening slot');
  if (['Medicaid', 'Others'].includes(appt.insurance_type)) factors.push(`${appt.insurance_type} insurance`);
  if (factors.length === 0) factors.push('New patient', 'No prior history');

  return factors.slice(0, 3).join(' | ').substring(0, 200);
}

// ─── OPENAI NARRATIVE ─────────────────────────────────────────────────────────

async function generateInterventionNarrative(patient, riskScore, riskBand, contributingFactors) {
  const prompt = `You are an AI scheduling assistant for Vanderlyn Medical Center.

Patient: ${patient.patient_first_name} ${patient.patient_last_name}
Appointment: ${patient.appointment_datetime} (${patient.service_line} - ${patient.appointment_sub_type})
Risk Score: ${riskScore}/100 (${riskBand})
Contributing Factors: ${contributingFactors}

Write a single concise sentence (max 25 words) explaining why this patient is at risk of not showing up and what action is recommended. Be direct and clinical.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 60,
  });
  return response.choices[0].message.content.trim();
}

// ─── ENDPOINT 1: DASHBOARD SUMMARY ────────────────────────────────────────────

app.get('/nova/dashboard', async (req, res) => {
  try {
    // Get all upcoming appointments
    const upcoming = await mavisQuery(APPOINTMENTS_TABLE, [
      { ColumnId: 'is_upcoming', Value: 'Yes' }
    ]);

    const total = upcoming.length;
    const highRisk = upcoming.filter(a => a.risk_band === 'High');
    const mediumRisk = upcoming.filter(a => a.risk_band === 'Medium');
    const lowRisk = upcoming.filter(a => a.risk_band === 'Low');
    const unscored = upcoming.filter(a => !a.risk_band);

    const totalRevenue = upcoming.reduce((s, a) => s + (parseFloat(a.revenue_value) || 0), 0);
    const highRiskRevenue = highRisk.reduce((s, a) => s + (parseFloat(a.revenue_value) || 0), 0);

    // Intervention stats
    const intervened = upcoming.filter(a => a.intervention_status && a.intervention_status !== 'None');
    const rescheduled = upcoming.filter(a => a.appointment_status === 'Rescheduled');

    // Clinic breakdown
    const byClinic = {};
    upcoming.forEach(a => {
      const clinic = a.clinic_location || 'Unknown';
      if (!byClinic[clinic]) byClinic[clinic] = { total: 0, high: 0, revenue: 0 };
      byClinic[clinic].total++;
      if (a.risk_band === 'High') byClinic[clinic].high++;
      byClinic[clinic].revenue += parseFloat(a.revenue_value) || 0;
    });

    // Service line breakdown
    const byService = {};
    upcoming.forEach(a => {
      const sl = a.service_line || 'Unknown';
      if (!byService[sl]) byService[sl] = { total: 0, high: 0 };
      byService[sl].total++;
      if (a.risk_band === 'High') byService[sl].high++;
    });

    // Waitlist stats
    const waitlist = await mavisQuery(WAITLIST_TABLE, [
      { ColumnId: 'waitlist_status', Value: 'Active' }
    ]);

    res.json({
      success: true,
      summary: {
        totalAppointments: total,
        predictedNoShows: highRisk.length,
        noShowRate: total > 0 ? ((highRisk.length / total) * 100).toFixed(1) : 0,
        revenueAtRisk: Math.round(highRiskRevenue),
        totalRevenue: Math.round(totalRevenue),
        mediumRisk: mediumRisk.length,
        lowRisk: lowRisk.length,
        unscored: unscored.length,
        intervened: intervened.length,
        rescheduled: rescheduled.length,
        activeWaitlist: waitlist.length,
      },
      byClinic,
      byService,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 2: AT-RISK PATIENT QUEUE ────────────────────────────────────────

app.get('/nova/patients', async (req, res) => {
  try {
    const { band, clinic, service, limit = 100 } = req.query;

    const filters = [{ ColumnId: 'is_upcoming', Value: 'Yes' }];
    if (band) filters.push({ ColumnId: 'risk_band', Value: band });
    if (clinic) filters.push({ ColumnId: 'clinic_location', Value: clinic });
    if (service) filters.push({ ColumnId: 'service_line', Value: service });

    const patients = await mavisQuery(APPOINTMENTS_TABLE, filters, parseInt(limit));

    // Sort: High first, then by risk_score desc
    patients.sort((a, b) => {
      const bandOrder = { High: 0, Medium: 1, Low: 2 };
      const bandDiff = (bandOrder[a.risk_band] ?? 3) - (bandOrder[b.risk_band] ?? 3);
      if (bandDiff !== 0) return bandDiff;
      return (parseInt(b.risk_score) || 0) - (parseInt(a.risk_score) || 0);
    });

    res.json({ success: true, total: patients.length, patients });
  } catch (err) {
    console.error('Patients error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 3: RUN RISK SCORING ─────────────────────────────────────────────

app.post('/nova/predict', async (req, res) => {
  try {
    const { useAI = false } = req.body;

    // Get all upcoming unscored (or rescore all)
    const upcoming = await mavisQuery(APPOINTMENTS_TABLE, [
      { ColumnId: 'is_upcoming', Value: 'Yes' }
    ]);

    // Get historical data for prior no-show counts
    const historical = await mavisQuery(APPOINTMENTS_TABLE, [
      { ColumnId: 'is_upcoming', Value: 'No' }
    ]);

    // Build per-patient history map
    const historyMap = {};
    historical.forEach(h => {
      const pid = h.patient_id;
      if (!historyMap[pid]) historyMap[pid] = { noShows: 0, cancellations: 0 };
      if (h.outcome === 'No-Show') historyMap[pid].noShows++;
      if (h.outcome === 'Cancelled') historyMap[pid].cancellations++;
    });

    const results = [];
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    for (const appt of upcoming) {
      const history = historyMap[appt.patient_id] || { noShows: 0, cancellations: 0 };
      const enriched = {
        ...appt,
        prior_no_shows: history.noShows,
        prior_cancellations: history.cancellations,
      };

      const riskScore = calcRiskScore(enriched);
      const riskBand = getRiskBand(riskScore);
      const contributingFactors = buildContributingFactors(enriched);

      let narrative = null;
      if (useAI && riskBand === 'High') {
        try {
          narrative = await generateInterventionNarrative(appt, riskScore, riskBand, contributingFactors);
        } catch (e) {
          narrative = null;
        }
      }

      // Update Mavis
      await mavisUpdate(APPOINTMENTS_TABLE, appt.RowId, {
        risk_score: riskScore,
        risk_band: riskBand,
        contributing_factors: contributingFactors,
        last_scored_at: now,
        prior_no_shows: history.noShows,
        prior_cancellations: history.cancellations,
      });

      // Update LeadSquared lead field
      if (appt.patient_id) {
        try {
          await lsqUpdateLead(appt.patient_id, {
            'NoShowRiskScore': (riskScore / 100).toFixed(2),
            'RiskBand': riskBand,
            'ContributingFactors': contributingFactors,
            'NovaConsoleLastScored': now,
          });
        } catch (e) {
          // Non-fatal — continue
        }
      }

      results.push({
        appointment_id: appt.appointment_id,
        patient_id: appt.patient_id,
        patient_name: `${appt.patient_first_name} ${appt.patient_last_name}`,
        appointment_datetime: appt.appointment_datetime,
        service_line: appt.service_line,
        risk_score: riskScore,
        risk_band: riskBand,
        contributing_factors: contributingFactors,
        narrative,
      });
    }

    const highCount = results.filter(r => r.risk_band === 'High').length;
    const highRevenue = upcoming
      .filter((_, i) => results[i]?.risk_band === 'High')
      .reduce((s, a) => s + (parseFloat(a.revenue_value) || 0), 0);

    res.json({
      success: true,
      scored: results.length,
      highRisk: highCount,
      revenueAtRisk: Math.round(highRevenue),
      results,
    });
  } catch (err) {
    console.error('Predict error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 4: SLOT RECOMMENDATION ──────────────────────────────────────────

app.post('/nova/slots/recommend', async (req, res) => {
  try {
    const { patient_id, service_line, current_slot_datetime } = req.body;

    if (!service_line) {
      return res.status(400).json({ success: false, error: 'service_line required' });
    }

    // Get available slots for this service line
    const slots = await mavisQuery(SLOTS_TABLE, [
      { ColumnId: 'is_available', Value: 'Yes' },
      { ColumnId: 'service_line', Value: service_line },
    ]);

    if (!slots.length) {
      return res.json({ success: true, slots: [], message: 'No available slots for this service line' });
    }

    // Filter future slots only
    const now = new Date();
    const futureSlots = slots.filter(s => new Date(s.slot_datetime) > now);

    // Score and rank slots
    const rankedSlots = futureSlots
      .map(slot => ({
        slot_id: slot.slot_id,
        slot_datetime: slot.slot_datetime,
        service_line: slot.service_line,
        slot_type: slot.slot_type,
        provider_name: slot.provider_name,
        predicted_fill_probability: parseFloat(slot.predicted_fill_probability) || 0.5,
        // Prefer morning slots (lower no-show risk)
        score: (parseFloat(slot.predicted_fill_probability) || 0.5) +
               (slot.slot_type === 'Morning' ? 0.1 : slot.slot_type === 'Afternoon' ? 0.05 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    res.json({
      success: true,
      patient_id,
      service_line,
      current_slot: current_slot_datetime,
      recommended_slots: rankedSlots,
    });
  } catch (err) {
    console.error('Slots error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 5: BACKFILL ─────────────────────────────────────────────────────

app.post('/nova/backfill', async (req, res) => {
  try {
    const { appointment_id, freed_slot_id, service_line } = req.body;

    if (!freed_slot_id || !service_line) {
      return res.status(400).json({ success: false, error: 'freed_slot_id and service_line required' });
    }

    // Mark freed slot as available
    const slotRows = await mavisQuery(SLOTS_TABLE, [{ ColumnId: 'slot_id', Value: freed_slot_id }]);
    if (slotRows.length) await mavisUpdate(SLOTS_TABLE, slotRows[0].RowId, { is_available: 'Yes' });

    // Find best waitlist candidate
    const waitlistCandidates = await mavisQuery(WAITLIST_TABLE, [
      { ColumnId: 'waitlist_status', Value: 'Active' },
      { ColumnId: 'preferred_service_line', Value: service_line },
    ]);

    if (!waitlistCandidates.length) {
      return res.json({
        success: true,
        slot_freed: freed_slot_id,
        backfilled: false,
        message: 'No active waitlist candidates for this service line',
      });
    }

    // Rank by urgency score desc, then days on waitlist desc
    waitlistCandidates.sort((a, b) => {
      const urgencyDiff = (parseInt(b.urgency_score) || 0) - (parseInt(a.urgency_score) || 0);
      if (urgencyDiff !== 0) return urgencyDiff;
      return (parseInt(b.days_on_waitlist) || 0) - (parseInt(a.days_on_waitlist) || 0);
    });

    const best = waitlistCandidates[0];
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Update waitlist record
    await mavisUpdate(WAITLIST_TABLE, best.RowId, {
      waitlist_status: 'Filled',
      assigned_slot_id: freed_slot_id,
      assigned_datetime: now,
    });

    // Mark slot as taken
    if (slotRows.length) await mavisUpdate(SLOTS_TABLE, slotRows[0].RowId, { is_available: 'No' });

    // Update original appointment
    if (appointment_id) {
      const aptRows = await mavisQuery(APPOINTMENTS_TABLE, [{ ColumnId: 'appointment_id', Value: appointment_id }]);
      if (aptRows.length) {
        await mavisUpdate(APPOINTMENTS_TABLE, aptRows[0].RowId, {
          waitlist_patient_assigned: `${best.patient_first_name} ${best.patient_last_name}`,
          intervention_outcome: 'Slot Filled',
        });
      }
    }

    res.json({
      success: true,
      slot_freed: freed_slot_id,
      backfilled: true,
      assigned_to: {
        patient_id: best.patient_id,
        patient_name: `${best.patient_first_name} ${best.patient_last_name}`,
        urgency_score: best.urgency_score,
        days_on_waitlist: best.days_on_waitlist,
        service_line: best.preferred_service_line,
      },
      timestamp: now,
    });
  } catch (err) {
    console.error('Backfill error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 6: INTERVENTION LOG ─────────────────────────────────────────────

app.get('/nova/interventions', async (req, res) => {
  try {
    const interventions = await mavisQuery(APPOINTMENTS_TABLE, [
      { ColumnId: 'is_upcoming', Value: 'Yes' },
    ], 200);

    const withInterventions = interventions.filter(
      a => a.intervention_status && a.intervention_status !== 'None' && a.intervention_status !== ''
    );

    withInterventions.sort((a, b) =>
      new Date(b.intervention_triggered_at || 0) - new Date(a.intervention_triggered_at || 0)
    );

    res.json({ success: true, total: withInterventions.length, interventions: withInterventions });
  } catch (err) {
    console.error('Interventions error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Nova Console API', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nova Console API running on port ${PORT}`));
