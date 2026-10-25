/**
 * Argon drone-plan prompt + response schema (server-side only, text-only call).
 * Bump PLAN_PROMPT_VERSION whenever the prompt text or schema changes: it is part of the plan-cache hash.
 */
import { Type } from '@google/genai';
import type { PlanRequest } from '../src/contracts';

export const PLAN_PROMPT_VERSION = 'argon-plan-v2';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const DS = ['none', 'slight', 'moderate', 'extensive', 'complete'];

export function buildPlanPrompt(req: PlanRequest): string {
  const d = req.drone;
  const s = req.situation;
  const cov = req.coverage;
  const rows = req.candidates
    .map((c) =>
      [
        c.id,
        c.label,
        c.kind ?? '-',
        `x=${c.x} z=${c.z}`,
        `${c.distanceFromBaseM} m`,
        c.scanned ? 'scanned' : 'NOT scanned',
        c.observed ? `Argon saw ${c.observed} (${pct(c.observedConfidence ?? 0)})` : 'no observation',
        `model: ${DS[c.predicted.mostLikely]}, P(major+) ${pct(c.predicted.pMajorPlus)}, P(destroyed) ${pct(c.predicted.pDestroyed)}`,
        `~${c.occupants} occupants`,
        c.peopleSeen !== undefined ? `${c.peopleSeen} people seen` : '',
        c.fire ? 'FIRE' : '',
        c.reason,
        `score ${c.score}`,
      ]
        .filter(Boolean)
        .join(' | '),
    )
    .join('\n');
  const prev = (req.previousPlans ?? []).length
    ? (req.previousPlans ?? []).map((p) => `- wave ${p.wave}: ${p.approved ? 'APPROVED' : 'rejected'} — ${p.missions.join('; ')}${p.outcome ? ` → ${p.outcome}` : ''}`).join('\n')
    : '- none';
  const perTargetS = d.orbitS;
  return `You are the air-operations coordinator in the San Francisco Emergency Operations Centre, ${Math.round(req.simS / 60)} min ${Math.round(req.simS % 60)} s after
a M7.8 San Andreas earthquake (1906 repeat) struck at ${req.localHour}:00 local time. Police helicopter AIR 1 is filming downtown
(Financial District / Chinatown / Jackson Square) and an AI analyst (you, Argon) has been reconstructing building damage from
its footage. You now command 3 small quadcopter drones (D1–D3) at the staging point at Embarcadero Plaza (x=${d.base[0]} z=${d.base[1]}).

GOAL: maximise LIFE-SAVING INFORMATION PER DRONE-MINUTE for the incident commander:
- confirm suspected collapses where people may be trapped (so rescue teams go to the right rubble pile);
- survey high-risk, densely occupied blocks the helicopter has NOT covered (or could not assess);
- resolve low-confidence or contradictory calls (model prediction vs what AIR 1 saw) on occupied buildings.
Do NOT waste drones on buildings already confidently assessed, empty / low-occupancy buildings, or targets far apart.

DRONES: speed ${d.speedMs} m/s, orbit altitude ${d.altitudeAGL} m AGL, endurance ${Math.round(d.enduranceS / 60)} min per sortie.
Each target costs transit time + a ${perTargetS} s close-up orbit; chain targets that are near each other (≤ ~300 m apart) on the
same drone and keep each sortie well inside the endurance. Wave ${req.wave} of at most 2. Drones available now: ${req.dronesAvailable.join(', ') || 'none'}.
${req.wave === 1 ? 'Wave 1 should normally keep ONE drone in reserve for a second wave (new collapses, follow-ups).' : 'This is the last wave: use the remaining drones on the most valuable remaining targets.'}
You MAY recommend holding (dispatch=false) — e.g. if AIR 1 is still covering the relevant area and will reach it shortly, or if no
candidate is worth a sortie — and explain why in holdReason.

HELICOPTER COVERAGE: ${pct(cov.scannedFraction)} of the core area scanned, status "${cov.heliStatus}", ${cov.chunksDone}/${cov.chunksTotal} footage chunks analysed.

SITUATION (from AIR 1 footage so far):
- confirmed collapses: ${s.collapsesObserved.length ? s.collapsesObserved.map((c) => `${c.label} (${pct(c.confidence)})`).join('; ') : 'none yet'}
- people seen on/at buildings: ${s.peopleSeen}
- crowds: ${s.crowds.length ? s.crowds.map((c) => `${c.place} ≈${c.approxCount}`).join('; ') : 'none reported'}
- fires: ${s.fires.length ? s.fires.join('; ') : 'none reported'}
- blocked roads: ${s.blockedRoads.length ? s.blockedRoads.join('; ') : 'none reported'}
- latest analyst summary: ${s.latestSummary || '-'}

PREVIOUS DRONE PLANS:
${prev}

CANDIDATE TARGETS (id | label | kind | position (m, +x east, -z north) | distance from staging | helicopter coverage | Argon observation |
blind model prediction | occupants now | people seen | fire | why it is a candidate | code priority score (a hint, not a rule)).
Area ids "A-<n>" are clusters of 2–4 adjacent buildings (one target, costs one orbit per building):
${rows || '(no candidates)'}

RULES:
- Use ONLY candidate ids from the table as targetIds (1–4 per drone; an area counts as its building count).
- Use only available drone ids, at most one mission per drone. priority 1 = most urgent.
- kind: "verify_building" (confirm specific buildings) or "survey_area" (sweep an unscanned block).
- rationale: 2–3 crisp sentences for the commander — what you are sending, where, and why it matters for lives; mention the reserve.
- purpose: one line per mission (≤ 20 words), concrete (what to confirm / look for).
- In rationale and purpose refer to targets by building name / address or block name (e.g. "235 Pine St", "the Jackson Square
  URM block"), never by candidate ids like "A-3" or "B0123" — the commander does not see ids.

Respond with ONE JSON object: {"dispatch":true,"rationale":"...","holdReason":"","missions":[{"droneId":"D1","kind":"verify_building","targetIds":["B0123"],"purpose":"...","priority":1}]}
`;
}

export const planResponseSchema = {
  type: Type.OBJECT,
  properties: {
    dispatch: { type: Type.BOOLEAN },
    rationale: { type: Type.STRING },
    holdReason: { type: Type.STRING },
    missions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          droneId: { type: Type.STRING, enum: ['D1', 'D2', 'D3'] },
          kind: { type: Type.STRING, enum: ['verify_building', 'survey_area'] },
          targetIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          purpose: { type: Type.STRING },
          priority: { type: Type.INTEGER },
        },
        required: ['droneId', 'kind', 'targetIds', 'purpose', 'priority'],
        propertyOrdering: ['droneId', 'kind', 'targetIds', 'purpose', 'priority'],
      },
    },
  },
  required: ['dispatch', 'rationale', 'missions'],
  propertyOrdering: ['dispatch', 'rationale', 'holdReason', 'missions'],
};
