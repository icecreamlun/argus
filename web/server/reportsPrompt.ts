/**
 * Argon resident-report triage prompt + response schema (server-side only, text-only call).
 * Bump REPORTS_PROMPT_VERSION whenever the prompt text or schema changes: it is part of the reports-cache hash.
 */
import { Type } from '@google/genai';
import type { ReportsRequest } from '../src/contracts';

export const REPORTS_PROMPT_VERSION = 'argon-reports-v2';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const LANG: Record<string, string> = { en: 'English', zh: 'Chinese', es: 'Spanish' };

export function buildReportsPrompt(req: ReportsRequest): string {
  const rows = req.reports
    .map((r) => {
      const cands = r.candidates.length
        ? r.candidates.map((c, k) => `    ${k + 1}. ${c.id} — ${c.label} · ${c.levels}-storey ${c.use} · ${c.distanceM} m from the GPS fix`).join('\n')
        : '    (no building within 120 m)';
      return `[${r.id}] T+${mmss(r.simS)} · ${LANG[r.lang] ?? r.lang} · GPS ±${r.accuracyM} m
  text: ${JSON.stringify(r.text)}
  candidate buildings (nearest first):
${cands}`;
    })
    .join('\n\n');
  return `You are Argon, the AI analyst in the San Francisco Emergency Operations Centre. A M7.8 San Andreas earthquake (1906 repeat)
struck at ${req.localHour}:00 local time. You triage RESIDENT REPORTS posted from a community app (SF311-style): short free text
(English, Chinese or Spanish; often urgent, terse, misspelled) plus the phone's GPS fix. Your readings become low-weight evidence
in the city damage map, so be accurate and calibrated — never invent anything the text does not say.

For EACH report (batch ${req.batchIndex}, ${req.reports.length} reports):
1. LINK it to the building it DESCRIBES — exactly one id from THAT report's candidate list, or null.
   - The GPS fix is where the REPORTER is (phone accuracy ±8-60 m), not necessarily the building described.
   - Default: the reporter talks about their own building → usually the nearest candidate, unless the text says otherwise.
   - "across the street", "opposite", "next door", "the building next to us", 对面, 隔壁, enfrente, al lado → NOT the nearest
     candidate: pick a nearby candidate that is a different building (typically the 2nd-4th nearest; prefer one on the named street).
   - An address number + street or a building name in the text that matches a candidate label wins over distance.
   - Vague location ("near Grant and Pine", "around Clay/Kearny"): link the nearest plausible candidate but lower credibility.
   - Road/street reports (blocked street, debris on the road) with no building damage described → buildingId null.
2. DAMAGE of the linked building, from the description (null if the text does not describe the building's condition):
   - none: "we are fine", "no damage", "building is OK", "held up fine", 没事, 没有损坏, sin daños;
   - slight: hairline / small cracks, plaster cracks, things fell off shelves, broken dishes, a cracked window;
   - moderate: big / diagonal cracks in walls or stairwell, many broken or blown-out windows, parapet / cornice / bricks fell
     from the facade, evacuated but standing;
   - extensive: leaning / tilting, partially collapsed (a corner, the back wall or part of a floor came down), bulging walls,
     buckled ground floor — still mostly standing;
   - collapsed: fully collapsed, pancaked, "came down", "it's gone", pile of rubble, upper floors caved in, destroyed, 全塌, se derrumbó.
3. peopleTrapped: number of people stated as trapped / stuck / inside and unable to get out (1 for "someone", "an old man";
   use the stated number; 0 if not stated). Do not infer from damage alone.
4. hazards: any of "fire", "smoke", "gas", "blocked road", "power lines", "water" that the text reports (empty if none).
5. credibility 0..1 — how much the city map should trust THIS reading:
   high (0.75-0.9): specific (address/name), first-hand ("our building", "we"), concrete physical details, consistent with others;
   medium (0.5-0.7): plausible but generic, or about a neighbouring building (second-hand view across a street);
   low (0.2-0.45): vague location, emotional exaggeration (shouting, "!!!", claims that do not fit the details), hearsay, or
   a duplicate that adds nothing new. A report that contradicts others about the same building gets lower credibility.
6. duplicateOf: if an EARLIER report in this batch describes the same building and situation, its id; otherwise omit.
7. note: ≤ 12 words for an operator toast; name the building by its address or name from the label (never the B-id), e.g. "linked to 820 Sacramento St · likely collapse, 3 trapped" or
   "street blocked · Kearny St near Clay" or "OK check-in · 610 Kearny St".
Also write "summary": 1-2 sentences on what this batch adds (collapses, trapped people, hazards, areas reported OK).
Output one analysis per report, in the same order, using the exact report ids.

REPORTS
${rows}
`;
}

export const reportsResponseSchema = {
  type: Type.OBJECT,
  properties: {
    analyses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          reportId: { type: Type.STRING },
          buildingId: { type: Type.STRING, nullable: true },
          damage: { type: Type.STRING, enum: ['none', 'slight', 'moderate', 'extensive', 'collapsed'], nullable: true },
          peopleTrapped: { type: Type.INTEGER },
          hazards: { type: Type.ARRAY, items: { type: Type.STRING } },
          credibility: { type: Type.NUMBER },
          duplicateOf: { type: Type.STRING },
          note: { type: Type.STRING },
        },
        required: ['reportId', 'buildingId', 'damage', 'peopleTrapped', 'hazards', 'credibility', 'note'],
        propertyOrdering: ['reportId', 'buildingId', 'damage', 'peopleTrapped', 'hazards', 'credibility', 'duplicateOf', 'note'],
      },
    },
    summary: { type: Type.STRING },
  },
  required: ['analyses', 'summary'],
  propertyOrdering: ['analyses', 'summary'],
};
