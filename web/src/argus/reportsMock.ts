/**
 * M6 offline fallback for POST /api/reports: deterministic keyword heuristic (EN / 中文 / ES) — no network.
 *   damage:  keyword ladder (collapse > partial/leaning > big cracks/windows/parapet > minor cracks > "we're OK");
 *   link:    an address / building name in the text that matches a candidate label wins; "across the street /
 *            next door / opposite / 对面 / 隔壁 / enfrente / al lado" → second-nearest candidate; else the nearest;
 *            road reports (blocked street, no building damage) → null;
 *   credibility by specificity (address +, vague "near X and Y" −, second-hand −, shouting −, duplicate −).
 * Never reads truthRef (reportsById is only used for the client-visible category).
 */
import type { CitizenReport, ObservedDamage, ReportAnalysis, ReportsRequest, ReportsResponse } from '../contracts';

const RX = {
  partial: /partial|partly|leaning|tilt|bulging|buckled|corner of the top floor|wall section fell|back wall|inclinado|歪|一部分/i,
  collapsed: /collaps|pancak|came down|caved in|fell down completely|pile of (rubble|bricks)|destroyed|it'?s gone|nothing left|derrumb|全塌|倒塌|瓦砾/i,
  moderate: /big crack|large .*crack|huge crack|windows? (blew|shatter)|shattered|broken windows|parapet|bricks fell|cornice|facade|grietas grandes|grietas enormes|ventanas rotas|大裂缝|裂得很厉害|窗户都碎|砖掉/i,
  slight: /minor|small crack|hairline|plaster|shel(f|ves)|dishes|pictures fell|light damage|ceiling tiles|grietas pequeñas|小裂缝/i,
  none: /no damage|we'?re ok|we are fine|all good|\bsafe\b|undamaged|held up fine|sin daños|estamos bien|todo bien|没事|没有损坏|平安/i,
  fire: /\bfire\b|flames|smoke|incendio|humo|着火|浓烟/i,
  gas: /\bgas\b|煤气/i,
  road: /blocked|impassable|can'?t drive|closed —|both lanes|bloqueada|堵住|车过不去/i,
  neighbour: /across|opposite|next door|enfrente|al lado|对面|隔壁/i,
  vague: /\bnear \w+ and \w+|around \w+\/|\bon \w+ near\b|cerca de|附近/i,
  second: /\bmy neighbou?rs\b|someone said|i heard/i,
};

const WORD: Record<ObservedDamage, string> = {
  none: 'no damage',
  slight: 'minor damage',
  moderate: 'moderate damage',
  extensive: 'partial collapse',
  collapsed: 'likely collapse',
};

function readDamage(t: string): ObservedDamage | null {
  if (RX.collapsed.test(t) && !RX.partial.test(t)) return 'collapsed';
  if (RX.partial.test(t)) return 'extensive';
  if (RX.collapsed.test(t)) return 'extensive';
  if (RX.moderate.test(t)) return 'moderate';
  if (RX.slight.test(t)) return 'slight';
  if (RX.none.test(t)) return 'none';
  return null;
}

function readTrapped(t: string): number {
  const m = t.match(/(\d+)\s*(people|ppl|poeple|personas|of them)/i) ?? t.match(/(\d+)\s*个人/) ?? t.match(/maybe\s+(\d+)/i);
  if (m) return Math.min(50, Number(m[1]));
  if (/someone is trapped|one person still inside|old man|una persona atrapada|一个人困/i.test(t)) return 1;
  return 0;
}

const shortLabel = (l: string) => {
  const parts = l.split(',').map((s) => s.trim());
  return (parts.find((p) => /^\d/.test(p)) ?? parts[0]).slice(0, 40);
};

export function createMockReportsResponse(req: ReportsRequest, reportsById?: ReadonlyMap<string, CitizenReport> | Record<string, CitizenReport>): ReportsResponse {
  const get = (id: string): CitizenReport | undefined =>
    reportsById ? (reportsById instanceof Map ? reportsById.get(id) : (reportsById as Record<string, CitizenReport>)[id]) : undefined;
  const analyses: ReportAnalysis[] = [];
  const seen: { id: string; buildingId: string; damage: ObservedDamage | null }[] = [];
  for (const r of req.reports) {
    const t = r.text;
    const tl = t.toLowerCase();
    const category = get(r.id)?.category;
    let damage = readDamage(t);
    const hazards: string[] = [];
    if (RX.fire.test(t) || category === 'fire') hazards.push('fire');
    if (RX.gas.test(t) || category === 'gas') hazards.push('gas');
    const road = RX.road.test(t) || category === 'road';
    if (road) hazards.push('blocked road');
    const trapped = readTrapped(t);

    // Link.
    const cands = r.candidates;
    let buildingId: string | null = null;
    let specific = false;
    const byText = cands.find((c) =>
      c.label.split(',').some((part) => {
        const p = part.trim().toLowerCase();
        if (p.length < 5) return false;
        const num = p.match(/^(\d+)\s+(\S+)/);
        return num ? tl.includes(`${num[1]} ${num[2]}`) : tl.includes(p);
      }),
    );
    if (road && !damage) buildingId = null;
    else if (byText) {
      buildingId = byText.id;
      specific = true;
    } else if (RX.neighbour.test(t)) buildingId = (cands[1] ?? cands[0])?.id ?? null;
    else buildingId = cands[0]?.id ?? null;

    // Credibility.
    let cred = 0.55;
    if (specific) cred += 0.15;
    if (RX.vague.test(t)) cred -= 0.15;
    if (RX.neighbour.test(t) || RX.second.test(t)) cred -= 0.1;
    if (/!!|[A-Z]{5,}/.test(t)) cred -= 0.08;
    if (r.accuracyM > 30) cred -= 0.05;
    if (damage === null && !hazards.length && !trapped) cred -= 0.15;
    const dup = buildingId ? seen.find((s) => s.buildingId === buildingId && (s.damage === damage || !damage)) : undefined;
    if (dup) cred -= 0.1;
    cred = Math.round(Math.min(0.95, Math.max(0.1, cred)) * 100) / 100;

    const label = buildingId ? shortLabel(cands.find((c) => c.id === buildingId)?.label ?? buildingId) : null;
    const what = trapped > 0 ? `${trapped} trapped` : damage ? WORD[damage] : hazards[0] ?? 'unclear';
    const note = label ? `linked to ${label} · ${what}` : road ? 'street blocked · no building linked' : `no building linked · ${what}`;
    analyses.push({
      reportId: r.id,
      buildingId,
      damage,
      peopleTrapped: trapped,
      hazards,
      credibility: cred,
      ...(dup ? { duplicateOf: dup.id } : {}),
      note: note.split(/\s+/).slice(0, 12).join(' '),
    });
    if (buildingId) seen.push({ id: r.id, buildingId, damage });
  }
  const collapses = analyses.filter((a) => a.damage === 'collapsed').length;
  const trapped = analyses.reduce((s, a) => s + a.peopleTrapped, 0);
  const ok = analyses.filter((a) => a.damage === 'none').length;
  return {
    batchIndex: req.batchIndex,
    analyses,
    summary: `${analyses.length} resident reports: ${collapses} collapse claims, ${trapped} people reported trapped, ${ok} OK check-ins (keyword heuristic).`,
    model: 'heuristic-mock',
    mode: 'mock',
    latencyMs: 0,
  };
}
