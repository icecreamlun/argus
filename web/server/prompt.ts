/**
 * Argon reconstruction prompt + response schema (server-side only).
 * Bump PROMPT_VERSION whenever the prompt text or schema changes: it is part of the replay-cache hash.
 */
import { Type } from '@google/genai';
import type { ReconstructionRequest } from '../src/contracts';

export const PROMPT_VERSION = 'argon-recon-v5';
/**
 * M4: drone close-up variant (request.source === 'drone'). Versioned separately so the helicopter prompt (and the
 * cached helicopter replay run, which is checked against PROMPT_VERSION) stays byte-identical.
 */
export const DRONE_PROMPT_VERSION = 'argon-recon-drone-v1';
export const promptVersionFor = (req: Pick<ReconstructionRequest, 'source'>) => (req.source === 'drone' ? DRONE_PROMPT_VERSION : PROMPT_VERSION);

const fmtHeading = (rad: number) => {
  const deg = ((((rad * 180) / Math.PI) % 360) + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${Math.round(deg)}° (${dirs[Math.round(deg / 45) % 8]})`;
};

/** Daylight description for the local hour (lighting context only). */
const lightAt = (h: number) => (h < 6 || h >= 20 ? 'night (streetlights out — city-wide power outage)' : h < 8 || h >= 18 ? 'low sun / dusk' : 'daylight');

export function buildPrompt(req: ReconstructionRequest, opts: { asImages: boolean }): string {
  if (req.source === 'drone') return buildDronePrompt(req, opts);
  // Which video seconds each building was AR-tagged in (identity/visibility only — no damage prediction).
  const seenIn = new Map<string, number[]>();
  req.frames.forEach((f, k) => {
    for (const id of f.taggedBuildingIds) {
      const a = seenIn.get(id) ?? [];
      a.push(k);
      seenIn.set(id, a);
    }
  });
  const n = req.frames.length;
  const media = opts.asImages
    ? `${n} still frames in time order (frame k is labelled "second k"; frames are 1 s apart)`
    : `a ${n}-second video at 1 frame per second (video second k == frame k)`;

  const flight = req.frames
    .map((f, k) => `  s${k}: heli at x=${Math.round(f.position[0])} z=${Math.round(f.position[2])} alt=${Math.round(f.position[1])} m, heading ${fmtHeading(f.heading)}`)
    .join('\n');

  const bl = req.buildings
    .map((b) => {
      const secs = seenIn.get(b.id);
      return [
        b.tag,
        b.address ?? '-',
        b.name ?? '-',
        `x=${Math.round(b.x)} z=${Math.round(b.z)}`,
        `${Math.round(b.height)} m / ${b.levels} fl`,
        b.use,
        secs ? `tagged s${secs[0]}-s${secs[secs.length - 1]}` : 'tagged ?',
      ].join(' | ');
    })
    .join('\n');

  return `You are an aerial damage-assessment analyst for the San Francisco Emergency Operations Center.
You are watching ${media} of electro-optical gimbal footage from police helicopter "AIR 1 · SFPD", flown over
downtown San Francisco (Financial District / Chinatown) minutes after a strong earthquake. Lighting: ${lightAt(req.localHour)}.

The footage carries an AR mapping overlay (like real police-helicopter AR systems):
- buildings are tagged with labels of the form "B#### · ADDRESS"; a small square dot just below each label marks the
  roof centre of the building it names (attribute what you see to the building under the dot, not to its neighbours;
  a collapsed building's dot sits on a low rubble heap or a gap, often with dust rising);
- streets are labelled with their names along the roadway;
- the top bar shows the callsign, time and camera info (ignore it).

TASK — reconstruct what is ACTUALLY VISIBLE, building by building, plus roads and crowds.

For each TAGGED building from the list below that you can actually SEE CLEARLY (its dot is on it, it is not hidden
behind another building, smoke or dust, and it is big enough in frame to judge), rate its damage with the FULL scale.
These are the visual cues in this footage:
- "none": roofline straight and complete, facade continuous, no debris at its base.
- "slight": a few cracks or light streaks, a little debris at the base; shape fully intact.
- "moderate": blackened / cracked facade patches, broken windows, a small rubble skirt along the base; still upright.
- "extensive": visible lean of about 3–6° against its neighbours, holes in the facade with exposed floor slabs,
  a broken-in roof centre, a large debris apron spilling into the street.
- "collapsed": EITHER complete failure still standing (crushed ground floor, 6–13° lean, roof mostly broken in) OR a
  roofless ruin: jagged wall stubs around a rubble core, much lower than its listed height, often with dust rising.
Do not default to "none": a building with a rubble skirt, broken windows or a lean is damaged. Use "extensive" and
"collapsed" whenever those cues are present. Compare against the listed height: a 40 m building that appears as a
low ruin is "collapsed".

OUTPUT (keep it compact — this is read live by a dispatcher):
- "intact": ids of tagged buildings you saw CLEARLY and are confident are undamaged (no filler: leave a building out
  rather than listing it here by default).
- "buildings": one entry per clearly-seen tagged building with ANY damage (slight or worse) OR with people, fire or smoke:
  notes: max 8 words describing what you see (write it BEFORE choosing damage);
  damage; confidence 0..1 (lower it when small in frame, partly occluded, in smoke/dust, or the tag is ambiguous);
  peopleVisible: number of people you can see on or immediately at the building (0 if none);
  trappedSigns: true only if people are on rubble or a roof, waving / signalling for help;
  fire: visible flames; smoke: visible smoke plume from it;
  evidenceS: the video second (integer 0..${n - 1}) where the evidence is clearest.
- OMIT every listed building you cannot see clearly or are unsure about. Reporting fewer, well-judged buildings is
  better than many guesses; never fill the list with "none".

ROADS: list streets (use the AR street labels) that are visibly "blocked" (debris across the carriageway) or "partial" (debris narrowing it);
optionally "clear" for major streets you clearly saw open. Give nearBuildingId when the blockage is next to a tagged building.
CROWDS: groups of people gathered in open spaces (plazas, parks, wide streets) with an approximate head count; place = the plaza/park/street name if you can tell.
SUMMARY: 2-4 short sentences for the incident commander: worst damage seen, collapses, people needing rescue, blocked routes.

RULES:
- Only report what is visible. Never invent buildings that are not in the list; use the exact "id" (B####) from the list.
- Skip listed buildings you cannot see well enough to judge (do not guess "none" for buildings you did not see clearly).
- Smoke and dust can hide damage: lower confidence rather than guessing.
- Positions: world metres, +x = east, -z = north (z decreases going north); the helicopter track below helps you relate the frame to the list.

Respond with ONE JSON object exactly of this shape (no markdown):
{"buildings":[{"id":"B0123","notes":"...","damage":"none|slight|moderate|extensive|collapsed","confidence":0.8,"peopleVisible":0,"trappedSigns":false,"fire":false,"smoke":false,"evidenceS":3}],
 "intact":["B0456"],
 "roads":[{"street":"STOCKTON STREET","notes":"...","status":"blocked|partial|clear","nearBuildingId":"B0123","evidenceS":4}],
 "crowds":[{"place":"Portsmouth Square","nearBuildingId":"B0789","approxCount":30,"evidenceS":6}],
 "summary":"..."}

HELICOPTER TRACK (per video second):
${flight}

TAGGED BUILDING LIST (id | address | name | position | height / floors | use | when tagged) — identity only, no damage information:
${bl}
`;
}

/** M4: low-altitude drone orbit around 1–4 TARGET buildings (close-up variant of the helicopter prompt). */
function buildDronePrompt(req: ReconstructionRequest, opts: { asImages: boolean }): string {
  const seenIn = new Map<string, number[]>();
  req.frames.forEach((f, k) => {
    for (const id of f.taggedBuildingIds) {
      const a = seenIn.get(id) ?? [];
      a.push(k);
      seenIn.set(id, a);
    }
  });
  const n = req.frames.length;
  const media = opts.asImages
    ? `${n} still frames in time order (frame k is labelled "second k"; frames are 1 s apart)`
    : `a ${n}-second video at 1 frame per second (video second k == frame k)`;
  const targets = new Set(req.targetBuildingIds ?? []);
  const flight = req.frames
    .map((f, k) => `  s${k}: drone at x=${Math.round(f.position[0])} z=${Math.round(f.position[2])} alt=${Math.round(f.position[1])} m, heading ${fmtHeading(f.heading)}`)
    .join('\n');
  const row = (b: ReconstructionRequest['buildings'][number]) => {
    const secs = seenIn.get(b.id);
    return [
      b.tag,
      b.address ?? '-',
      b.name ?? '-',
      `x=${Math.round(b.x)} z=${Math.round(b.z)}`,
      `${Math.round(b.height)} m / ${b.levels} fl`,
      b.use,
      secs ? `tagged s${secs[0]}-s${secs[secs.length - 1]}` : 'tagged ?',
    ].join(' | ');
  };
  const tl = req.buildings.filter((b) => targets.has(b.id)).map(row).join('\n') || '(none tagged — see the list below)';
  const ol = req.buildings.filter((b) => !targets.has(b.id)).map(row).join('\n') || '(none)';
  const drone = req.droneId ? `quadcopter drone "${req.droneId}"` : 'a quadcopter drone';

  return `You are an aerial damage-assessment analyst for the San Francisco Emergency Operations Center.
You are watching ${media} from ${drone}${req.missionId ? ` (mission ${req.missionId})` : ''}, dispatched minutes after a strong
earthquake to VERIFY specific buildings in downtown San Francisco (Financial District / Chinatown). The drone flies a slow
low-altitude ORBIT (~70 m above ground) around each TARGET building with its camera locked on it, so the targets are seen
close up and from several sides. Lighting: ${lightAt(req.localHour)}.

The footage carries an AR mapping overlay: buildings are tagged "B#### · ADDRESS" with a small square dot just below each label
on the roof centre of the building it names (attribute what you see to the building under the dot); streets are labelled along
the roadway; the top bar shows callsign / time / camera info (ignore it).

PRIORITY: the TARGET buildings listed below. Report EVERY target you can see, first and most carefully — this close-up is the
ground truth the incident commander will send rescue teams on:
- damage on the full scale (cues below); look at all sides of the orbit: a facade that looks fine from one side may be
  sheared or collapsed on another;
- peopleVisible: count people on, in front of or on the rubble of the target (the close-up lets you count individuals);
- trappedSigns: people on rubble / a roof / at a window, waving or signalling for help;
- access: in "notes" mention whether the street in front is blocked by debris; also report it under ROADS.
Then also report any OTHER tagged building that is clearly visible and clearly judgeable (same rules as the targets, but
omit anything small, distant or partly hidden).

Damage cues:
- "none": roofline straight and complete, facade continuous, no debris at its base.
- "slight": a few cracks or light streaks, a little debris at the base; shape fully intact.
- "moderate": blackened / cracked facade patches, broken windows, a small rubble skirt along the base; still upright.
- "extensive": visible lean of about 3–6° against its neighbours, holes in the facade with exposed floor slabs,
  a broken-in roof centre, a large debris apron spilling into the street.
- "collapsed": EITHER complete failure still standing (crushed ground floor, 6–13° lean, roof mostly broken in) OR a
  roofless ruin: jagged wall stubs around a rubble core, much lower than its listed height, often with dust rising.
Do not default to "none": a building with a rubble skirt, broken windows or a lean is damaged. Compare against the listed
height: a 40 m building that appears as a low ruin is "collapsed". Close-up drone views justify HIGHER confidence (0.85–0.95)
when the target is clearly in frame; lower it only for smoke, dust or occlusion.

OUTPUT (compact — read live by a dispatcher):
- "buildings": one entry per TARGET you can see (even if undamaged: damage "none") and per other clearly-seen tagged building
  with ANY damage or with people, fire or smoke: notes (max 12 words, written BEFORE choosing damage; include access/street
  blockage for targets), damage, confidence 0..1, peopleVisible, trappedSigns, fire (visible flames), smoke (visible plume),
  evidenceS (video second 0..${n - 1} where the evidence is clearest).
- "intact": ids of OTHER (non-target) tagged buildings seen clearly and confidently undamaged.
- ROADS: streets (AR street labels) visibly "blocked" or "partial" by debris (or "clear" if clearly open) next to the targets,
  with nearBuildingId.
- CROWDS: groups of people in open spaces with an approximate head count.
- SUMMARY: 2-3 short sentences for the incident commander, targets first: state of each target, people / trapped, access.

RULES: only report what is visible; use the exact "id" (B####) from the lists; never invent buildings. Positions: world metres,
+x = east, -z = north.

Respond with ONE JSON object exactly of this shape (no markdown):
{"buildings":[{"id":"B0123","notes":"...","damage":"none|slight|moderate|extensive|collapsed","confidence":0.9,"peopleVisible":0,"trappedSigns":false,"fire":false,"smoke":false,"evidenceS":3}],
 "intact":["B0456"],
 "roads":[{"street":"STOCKTON STREET","notes":"...","status":"blocked|partial|clear","nearBuildingId":"B0123","evidenceS":4}],
 "crowds":[{"place":"Portsmouth Square","nearBuildingId":"B0789","approxCount":30,"evidenceS":6}],
 "summary":"..."}

DRONE TRACK (per video second):
${flight}

TARGET BUILDINGS (id | address | name | position | height / floors | use | when tagged):
${tl}

OTHER TAGGED BUILDINGS (identity only, no damage information):
${ol}
`;
}

const DAMAGE = ['none', 'slight', 'moderate', 'extensive', 'collapsed'];

/** Gemini responseSchema (OpenAPI subset) matching ReconstructionResult's model-produced fields. */
export const responseSchema = {
  type: Type.OBJECT,
  properties: {
    intact: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Ids of tagged buildings seen clearly and judged undamaged' },
    buildings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'Building id from the list, e.g. B0123' },
          notes: { type: Type.STRING, description: 'Short description of what is visible' },
          damage: { type: Type.STRING, enum: DAMAGE },
          confidence: { type: Type.NUMBER },
          peopleVisible: { type: Type.INTEGER },
          trappedSigns: { type: Type.BOOLEAN },
          fire: { type: Type.BOOLEAN },
          smoke: { type: Type.BOOLEAN },
          evidenceS: { type: Type.INTEGER },
        },
        required: ['id', 'notes', 'damage', 'confidence', 'peopleVisible', 'trappedSigns', 'fire', 'smoke', 'evidenceS'],
        propertyOrdering: ['id', 'notes', 'damage', 'confidence', 'peopleVisible', 'trappedSigns', 'fire', 'smoke', 'evidenceS'],
      },
    },
    roads: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          street: { type: Type.STRING },
          nearBuildingId: { type: Type.STRING },
          status: { type: Type.STRING, enum: ['blocked', 'partial', 'clear'] },
          evidenceS: { type: Type.INTEGER },
          notes: { type: Type.STRING },
        },
        required: ['street', 'status', 'evidenceS'],
        propertyOrdering: ['street', 'notes', 'status', 'nearBuildingId', 'evidenceS'],
      },
    },
    crowds: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          place: { type: Type.STRING },
          nearBuildingId: { type: Type.STRING },
          approxCount: { type: Type.INTEGER },
          evidenceS: { type: Type.INTEGER },
        },
        required: ['approxCount', 'evidenceS'],
        propertyOrdering: ['place', 'nearBuildingId', 'approxCount', 'evidenceS'],
      },
    },
    summary: { type: Type.STRING },
  },
  required: ['intact', 'buildings', 'roads', 'crowds', 'summary'],
  propertyOrdering: ['buildings', 'intact', 'roads', 'crowds', 'summary'],
};
