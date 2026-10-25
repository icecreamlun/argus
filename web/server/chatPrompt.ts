/**
 * M5 Argus Copilot: system prompt, compact situation packing and response schema (server-side only).
 * Bump CHAT_PROMPT_VERSION whenever the prompt text, the situation packing or the schema changes: it is part
 * of the chat-cache hash.
 */
import { Type } from '@google/genai';
import type { CopilotSituation, RescueIncident, UnitType } from '../src/contracts';

export const CHAT_PROMPT_VERSION = 'argus-copilot-v3';

export const UNIT_TYPES: UnitType[] = ['engine', 'truck', 'usar', 'ambulance', 'police', 'helicopter'];

export const CHAT_SYSTEM_PROMPT = `You are ARGUS Copilot, the incident-command assistant in the San Francisco Emergency Operations Center, minutes after a M7.8 San Andreas earthquake. You advise the Incident Commander on rescue priorities, resource allocation and routing. The commander decides; you recommend.

GROUND TRUTH YOU MAY USE (provided as JSON each turn):
- incidents: Argon-verified observations from helicopter and drone footage (collapses, people seen, trapped signs, fires, crowds) with confidence and evidence, plus model-predicted high-risk areas not yet observed (verified=false, clearly "unverified").
- roads: segments verified blocked, and segments predicted likely blocked.
- facilities: real fire stations, police stations, hospitals, staging areas.
- travelTimes: road-network ETAs (minutes) from each facility to each incident, already avoiding verified blockages; airMin for helicopters flying direct. NEVER invent distances or ETAs; use only these.

PRIORITIES (life safety first, golden hours):
1. Verified trapped survivors in collapsed or extensively damaged buildings — more people and higher confidence first.
2. Fires threatening occupied or collapsed buildings (fire spread kills trapped survivors).
3. High-occupancy suspected collapses that are unverified — send recon or a light unit, not the whole force.
4. Crowds: safety, access corridors, casualty collection points.
5. Keep evacuation and ambulance corridors open (police traffic control).

UNIT CAPABILITIES:
- engine: fire suppression, light rescue, first medical response.
- truck: heavy rescue, forcible entry, aerial ladder, rooftop access.
- usar: collapsed-structure search and rescue task force (scarce, highest value).
- ambulance: patient transport to the listed hospitals.
- police: cordons, traffic control, clearing routes, crowd management.
- helicopter: aerial recon, hoist and rooftop rescue, medevac; use for sites unreachable by road or with people on roofs.

RULES:
- Use exactly the units the commander says they have. If something is not specified, state your assumption in one line (plan.assumptions).
- Every assignment must reference an incidentId and a fromFacilityId from the data. Do not invent buildings, streets or units.
- Prefer routes that avoid verified-blocked roads; if a site is only reachable through blocked roads (roadMin null), assign police or trucks to clear the route, or a helicopter.
- Say what is uncertain and what to re-check next (e.g. "send a drone to verify B4721 before committing USAR").
- No medical advice beyond routing patients to hospitals.
- Be decisive and brief: lead with the top 3 priorities and the numbers that justify them.

OUTPUT (JSON matching the schema):
- reply: markdown, at most ~180 words, in the commander's language (Chinese if they write Chinese).
- plan: { priorities: [{rank, incidentId, reason}], assignments: [{unitType, count, fromFacilityId, incidentId, task}], routeClearing: [{roadName, unitType, reason}], reassessInMinutes, assumptions } — or null if the question needs no plan (e.g. "how many people are trapped?").`;

/** Implementation notes appended after the verbatim prompt (format details only; keep the spirit above). */
export const CHAT_FORMAT_NOTES = `
DATA FORMAT NOTES:
- travelTimes is grouped by incidentId: { "<incidentId>": [[fromFacilityId, roadMin|null, airMin, likelyBlocked?], ...] }, fastest first, only the closest facilities per kind are listed.
- roads lists street names with how many segments are verified_blocked / likely_blocked; use these names verbatim in routeClearing.roadName.
- When you give totals (people seen, trapped sites, collapses, fires), take them from summary and incidents; quote incident ids (e.g. I-B3291) and labels so the commander can find them on the map.
- The commander's unit counts are totals for the whole city; split them across facilities and incidents, each assignment count >= 1. Do not assign more units of a type than the commander has.
- "fire engines" / "fire trucks" / "消防车" mean engines unless the commander names ladder trucks, USAR or rescue teams separately; if heavy rescue needs trucks/USAR they do not have, say so in assumptions (request mutual aid) instead of converting engines.
- Police doing traffic control / route clearing still appear as assignments: split them over 2-4 sites or corridors (never one row with every officer).
- Keep it fast and scannable: reply <= 160 words (Chinese: <= 280 characters); at most 5 priorities, 12 assignment rows (one row per unit type + facility + incident, use count), 4 routeClearing rows; every task and reason <= 12 words; assumptions <= 3 short lines.`;

// ───────────────────────────── compact situation (what the model sees) ─────────────────────────────

const r1 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v * 10) / 10);
const r2 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v * 100) / 100);

/** Static importance used only to trim very large situations (keep the incidents the model needs). */
export function incidentWeight(i: RescueIncident): number {
  const c = i.confidence ?? 0.5;
  if (i.verified && (i.kind === 'trapped' || i.trappedSigns)) return 1000 + (i.peopleSeen ?? 1) * 10 * c;
  if (i.verified && (i.kind === 'fire' || i.fire)) return 800 + (i.occupants ?? 0) * 0.01;
  if (i.verified && i.kind === 'collapse') return 700 + (i.peopleSeen ?? 0) * 10 + (i.occupants ?? 0) * 0.01;
  if (i.kind === 'suspected_collapse') return 300 + (i.pDestroyed ?? 0) * (i.occupants ?? 0) * 0.1;
  if (i.kind === 'crowd') return 200 + (i.crowdSize ?? 0);
  return 100 * c;
}

const MAX_INCIDENTS = 45;
const PER_KIND: Record<string, number> = { fire_station: 3, police_station: 2, hospital: 2, staging: 1, helipad: 1 };

function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out as Partial<T>;
}

export function compactSituation(s: CopilotSituation) {
  const incidents = [...(s.incidents ?? [])].sort((a, b) => incidentWeight(b) - incidentWeight(a)).slice(0, MAX_INCIDENTS);
  const keepInc = new Set(incidents.map((i) => i.id));
  const facKind = new Map((s.facilities ?? []).map((f) => [f.id, f.kind]));

  // travelTimes grouped by incident: fastest per facility kind.
  const byInc = new Map<string, CopilotSituation['travelTimes']>();
  for (const t of s.travelTimes ?? []) {
    if (!keepInc.has(t.incidentId)) continue;
    const l = byInc.get(t.incidentId) ?? [];
    l.push(t);
    byInc.set(t.incidentId, l);
  }
  const travelTimes: Record<string, (string | number | null | true)[][]> = {};
  for (const inc of incidents) {
    const l = (byInc.get(inc.id) ?? []).sort((a, b) => (a.roadMin ?? 1e9) - (b.roadMin ?? 1e9) || a.airMin - b.airMin);
    const count = new Map<string, number>();
    const rows: (string | number | null | true)[][] = [];
    for (const t of l) {
      const k = facKind.get(t.fromFacilityId) ?? 'other';
      const n = count.get(k) ?? 0;
      if (n >= (PER_KIND[k] ?? 1)) continue;
      count.set(k, n + 1);
      const row: (string | number | null | true)[] = [t.fromFacilityId, t.roadMin === null ? null : r1(t.roadMin)!, r1(t.airMin)!];
      if (t.passesLikelyBlocked) row.push(true);
      rows.push(row);
    }
    if (rows.length) travelTimes[inc.id] = rows;
  }

  // Roads grouped by street name.
  const roadMap = new Map<string, { name: string; verified_blocked: number; likely_blocked: number; partial: number; source: Set<string> }>();
  for (const r of s.roads ?? []) {
    const name = r.name?.trim() || r.roadId;
    const e = roadMap.get(name) ?? { name, verified_blocked: 0, likely_blocked: 0, partial: 0, source: new Set<string>() };
    e[r.status]++;
    e.source.add(r.source);
    roadMap.set(name, e);
  }
  const roads = [...roadMap.values()]
    .sort((a, b) => b.verified_blocked - a.verified_blocked || b.likely_blocked - a.likely_blocked)
    .slice(0, 40)
    .map((e) => clean({ name: e.name, verified_blocked: e.verified_blocked || undefined, likely_blocked: e.likely_blocked || undefined, partial: e.partial || undefined, source: [...e.source].join('+') }));

  return {
    scenarioId: s.scenarioId,
    localTime: s.localTime,
    minutesSinceQuake: r1(s.minutesSinceQuake),
    summary: { ...s.summary, areaScannedPct: r1(s.summary?.areaScannedPct), latestArgonSummary: (s.summary?.latestArgonSummary ?? '').slice(0, 500) },
    incidentsTotal: s.incidents?.length ?? 0,
    incidents: incidents.map((i) =>
      clean({
        id: i.id,
        kind: i.kind,
        label: i.label,
        verified: !!i.verified,
        confidence: r2(i.confidence),
        damage: i.damage,
        peopleSeen: i.peopleSeen || undefined,
        trappedSigns: i.trappedSigns || undefined,
        fire: i.fire || undefined,
        crowdSize: i.crowdSize || undefined,
        occupants: i.occupants !== undefined ? Math.round(i.occupants) : undefined,
        pDestroyed: r2(i.pDestroyed),
        evidence: i.evidence,
      }),
    ),
    roads,
    facilities: (s.facilities ?? []).map((f) => clean({ id: f.id, kind: f.kind, name: f.name, units: f.units && Object.keys(f.units).length ? f.units : undefined })),
    travelTimes,
  };
}

// ───────────────────────────── response schema ─────────────────────────────

export const chatResponseSchema = {
  type: Type.OBJECT,
  properties: {
    reply: { type: Type.STRING },
    plan: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        priorities: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { rank: { type: Type.INTEGER }, incidentId: { type: Type.STRING }, reason: { type: Type.STRING } },
            required: ['rank', 'incidentId', 'reason'],
            propertyOrdering: ['rank', 'incidentId', 'reason'],
          },
        },
        assignments: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              unitType: { type: Type.STRING, enum: UNIT_TYPES },
              count: { type: Type.INTEGER },
              fromFacilityId: { type: Type.STRING },
              incidentId: { type: Type.STRING },
              task: { type: Type.STRING },
            },
            required: ['unitType', 'count', 'fromFacilityId', 'incidentId', 'task'],
            propertyOrdering: ['unitType', 'count', 'fromFacilityId', 'incidentId', 'task'],
          },
        },
        routeClearing: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { roadName: { type: Type.STRING }, unitType: { type: Type.STRING, enum: UNIT_TYPES }, reason: { type: Type.STRING } },
            required: ['roadName', 'unitType', 'reason'],
            propertyOrdering: ['roadName', 'unitType', 'reason'],
          },
        },
        reassessInMinutes: { type: Type.INTEGER },
        assumptions: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['priorities', 'assignments', 'routeClearing', 'reassessInMinutes'],
      propertyOrdering: ['priorities', 'assignments', 'routeClearing', 'reassessInMinutes', 'assumptions'],
    },
  },
  required: ['reply'],
  propertyOrdering: ['reply', 'plan'],
};
