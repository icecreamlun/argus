/**
 * M5 Argus Copilot — deterministic offline fallback for POST /api/chat (no network, no model).
 *
 * createMockChatResponse(req) parses the commander's unit counts (EN + Chinese numerals/digits, e.g.
 * "10辆消防车", "20名警察", "两架直升机", "6 ambulances"; earlier user turns fill in types the latest question
 * omits), ranks incidents (verified trapped by people×confidence → verified fires → verified collapses →
 * unverified suspected collapses → crowds), assigns each unit type from the facility with the fastest
 * travelTimes entry, sends police to the most-blocked roads + crowds, helicopters to road-unreachable /
 * rooftop sites, and replies in the question's language. Questions that need no plan get plan = null.
 */
import type { ChatRequest, ChatResponse, CopilotSituation, Facility, FacilityKind, RescueIncident, RescuePlan, TravelTime, UnitType } from '../contracts';

const UNIT_ORDER: UnitType[] = ['usar', 'truck', 'engine', 'ambulance', 'police', 'helicopter'];

// ───────────────────────────── unit-count parsing ─────────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const EN_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, dozen: 12,
};

/** "十二" → 12, "二十" → 20, "两" → 2, "一百二十" → 120, "12" → 12. */
export function parseNumber(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  if (t in EN_NUM) return EN_NUM[t];
  if (!/^[零〇一二两俩三四五六七八九十百]+$/.test(t)) return null;
  let total = 0;
  let cur = 0;
  for (const ch of t) {
    if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
    } else cur = CN_DIGIT[ch] ?? 0;
  }
  return total + cur;
}

const NUM = String.raw`(\d+|[零〇一二两俩三四五六七八九十百]+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|dozen)`;
const UNIT_WORDS: [UnitType, string][] = [
  ['usar', String.raw`usar(?:\s*(?:teams?|task\s*forces?|units?))?|(?:urban\s+)?search[\s-]+and[\s-]+rescue(?:\s+(?:teams?|units?|task\s*forces?))?|rescue\s+teams?|搜救队|救援队|城市搜救队|重型救援队`],
  ['truck', String.raw`(?:ladder\s+|aerial\s+|rescue\s+)?trucks?|truck\s+companies|云梯车|登高车|抢险车|救援车|重型救援车`],
  ['engine', String.raw`(?:fire\s+)?engines?|fire\s+trucks?|fire\s+(?:apparatus|units?)|engine\s+companies|消防车|消防车辆|水罐车|消防队`],
  ['ambulance', String.raw`ambulances?|medic\s+units?|paramedic\s+units?|救护车|急救车`],
  ['police', String.raw`(?:police\s+)?officers?|police(?:\s+(?:units?|cars?|men))?|cops|patrol\s+(?:cars?|units?)|警察|警员|民警|警力|警车|巡警`],
  ['helicopter', String.raw`helicopters?|helos?|choppers?|直升机|直升飞机`],
];

/** Unit counts stated in one message (types not mentioned are absent). */
export function parseUnitCounts(text: string): Partial<Record<UnitType, number>> {
  const out: Partial<Record<UnitType, number>> = {};
  const src = text.toLowerCase();
  for (const [type, words] of UNIT_WORDS) {
    // "10 fire engines" / "10辆消防车" / "二十名警察" / "2 more ambulances"
    const re = new RegExp(`(?<![a-z0-9])${NUM}\\s*(?:个|辆|名|架|支|位|台|部|队|组)?\\s*(?:more\\s+|additional\\s+|extra\\s+|available\\s+)?(?:${words})`, 'giu');
    for (const m of src.matchAll(re)) {
      const n = parseNumber(m[1]);
      if (n && n > 0 && n < 1000) {
        out[type] = (out[type] ?? 0) + n;
        break;
      }
    }
    if (out[type] === undefined) {
      // "engines: 10" / "消防车10辆"
      const re2 = new RegExp(`(?:${words})\\s*[:：x×]?\\s*${NUM}\\s*(?:个|辆|名|架|支|位|台|部|队|组)?`, 'iu');
      const m = re2.exec(src);
      const n = m ? parseNumber(m[1]) : null;
      if (n && n > 0 && n < 1000) out[type] = n;
    }
  }
  return out;
}

const isChinese = (s: string) => /[一-鿿]/.test(s);

// ───────────────────────────── ranking + assignment ─────────────────────────────

function rankScore(i: RescueIncident): number {
  const c = i.confidence ?? 0.5;
  if (i.verified && (i.kind === 'trapped' || i.trappedSigns)) return 10000 + Math.max(1, i.peopleSeen ?? 1) * c * 100;
  if (i.verified && (i.kind === 'fire' || i.fire)) return 5000 + (i.occupants ?? 0) * 0.1 + (i.damage === 'collapsed' ? 500 : 0);
  if (i.verified && i.kind === 'collapse') return 3000 + (i.peopleSeen ?? 0) * 50 + (i.occupants ?? 0) * 0.1;
  if (i.kind === 'suspected_collapse' || !i.verified) return 1000 + (i.pDestroyed ?? 0.3) * (i.occupants ?? 50);
  if (i.kind === 'crowd') return 500 + (i.crowdSize ?? 0);
  return 100 * c;
}

const FAC_FOR: Record<UnitType, FacilityKind[]> = {
  engine: ['fire_station'],
  truck: ['fire_station'],
  usar: ['staging', 'fire_station'],
  ambulance: ['hospital', 'staging', 'fire_station'],
  police: ['police_station', 'staging'],
  helicopter: ['helipad', 'staging', 'police_station', 'fire_station', 'hospital'],
};

interface Ctx {
  s: CopilotSituation;
  fac: Map<string, Facility>;
  tt: Map<string, TravelTime[]>; // by incident
}

/** Fastest facility of an acceptable kind for this unit type → incident (road ETA; helicopters by air). */
function nearest(ctx: Ctx, unit: UnitType, inc: RescueIncident): { f: Facility; t?: TravelTime } | null {
  const kinds = FAC_FOR[unit];
  const rows = (ctx.tt.get(inc.id) ?? []).filter((t) => {
    const f = ctx.fac.get(t.fromFacilityId);
    return f && kinds.includes(f.kind) && (unit === 'helicopter' || t.roadMin !== null);
  });
  const eta = (t: TravelTime) => (unit === 'helicopter' ? t.airMin : t.roadMin!) + kinds.indexOf(ctx.fac.get(t.fromFacilityId)!.kind) * 0.5;
  rows.sort((a, b) => eta(a) - eta(b));
  if (rows.length) return { f: ctx.fac.get(rows[0].fromFacilityId)!, t: rows[0] };
  // No travel time: straight-line nearest facility of the preferred kind.
  let best: Facility | null = null;
  let bd = Infinity;
  for (const f of ctx.s.facilities) {
    if (!kinds.includes(f.kind)) continue;
    const d = Math.hypot(f.x - inc.x, f.z - inc.z) * (1 + kinds.indexOf(f.kind) * 0.3);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best ? { f: best } : null;
}

const roadReachable = (ctx: Ctx, inc: RescueIncident) => (ctx.tt.get(inc.id) ?? []).some((t) => t.roadMin !== null) || !(ctx.tt.get(inc.id) ?? []).length;

function topBlockedRoads(s: CopilotSituation, n: number): { name: string; verified: number; likely: number }[] {
  const m = new Map<string, { name: string; verified: number; likely: number }>();
  for (const r of s.roads) {
    const name = r.name?.trim();
    if (!name) continue;
    const e = m.get(name) ?? { name, verified: 0, likely: 0 };
    if (r.status === 'verified_blocked') e.verified++;
    else if (r.status === 'likely_blocked') e.likely++;
    m.set(name, e);
  }
  return [...m.values()].sort((a, b) => b.verified - a.verified || b.likely - a.likely).slice(0, n);
}

const DEFAULT_UNITS: Record<UnitType, number> = { engine: 8, truck: 3, usar: 1, ambulance: 6, police: 12, helicopter: 1 };

// ───────────────────────────── main ─────────────────────────────

export function createMockChatResponse(req: ChatRequest): ChatResponse {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const s = req.situation;
  const userTurns = req.messages.filter((m) => m.role === 'user');
  const q = userTurns[userTurns.length - 1]?.text ?? '';
  const zh = isChinese(q);
  const ql = q.toLowerCase();

  // Units: latest question wins per type; earlier turns fill gaps.
  const stated: Partial<Record<UnitType, number>> = {};
  for (const m of userTurns) Object.assign(stated, parseUnitCounts(m.text));
  const statedAny = Object.keys(stated).length > 0;

  const incidents = [...s.incidents].sort((a, b) => rankScore(b) - rankScore(a) || a.id.localeCompare(b.id));
  const trapped = incidents.filter((i) => i.verified && (i.kind === 'trapped' || i.trappedSigns));
  const peopleTrapped = trapped.reduce((a, i) => a + (i.peopleSeen ?? 0), 0);
  const fires = incidents.filter((i) => i.verified && (i.kind === 'fire' || i.fire));
  const label = (i: RescueIncident) => `**${i.label}** (${i.id})`;

  const statedNow = Object.keys(parseUnitCounts(q)).length > 0;
  const planWords = /route|routing|priorit|allocate|assign|dispatch|send|deploy|plan|what changes|cleared|安排|路线|优先|调度|派|部署|分配|方案|清理|疏通|打通/.test(ql);
  const infoWords = /how many|where|which|status|多少|哪里|哪些|几处|几个|情况/.test(ql);
  const wantsPlan = statedNow || (planWords && !(infoWords && !/what changes|cleared|清理|疏通|打通/.test(ql)));

  // ── Info-only questions ──
  if (!wantsPlan) {
    const top = trapped.slice(0, 5);
    const lines = top.map((i) => `- ${label(i)}: ${i.peopleSeen ?? '?'} ${zh ? '人' : 'people'}, ${Math.round((i.confidence ?? 0) * 100)}%${i.evidence ? ` · ${i.evidence}` : ''}`);
    const reply = zh
      ? `**已核实被困点 ${trapped.length} 处，可见人员约 ${peopleTrapped} 人**（全部画面共见 ${s.summary.peopleSeen} 人）。\n\n${lines.join('\n') || '- 暂无核实的被困点'}\n\n另有 ${s.summary.collapsesVerified} 栋倒塌已核实、${fires.length} 处火情。已扫描约 ${Math.round(s.summary.areaScannedPct)}% 区域，未核实的高风险建筑仍需无人机复核。`
      : `**${trapped.length} verified trapped sites, ~${peopleTrapped} people visible** (${s.summary.peopleSeen} people seen in all footage).\n\n${lines.join('\n') || '- No verified trapped sites yet'}\n\nAlso ${s.summary.collapsesVerified} verified collapses and ${fires.length} fires. Only ~${Math.round(s.summary.areaScannedPct)}% of the area is scanned — unverified high-risk buildings still need drone checks.`;
    return { reply, plan: null, model: 'mock-heuristic', mode: 'mock', latencyMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) };
  }

  // ── Plan ──
  const units: Record<UnitType, number> = { engine: 0, truck: 0, usar: 0, ambulance: 0, police: 0, helicopter: 0 };
  const assumptions: string[] = [];
  for (const u of UNIT_ORDER) {
    if (stated[u] !== undefined) units[u] = stated[u]!;
    else if (!statedAny) units[u] = DEFAULT_UNITS[u];
  }
  if (!statedAny) assumptions.push(zh ? `未说明可用力量，按默认 ${Object.entries(DEFAULT_UNITS).map(([k, v]) => `${v} ${k}`).join('、')} 估算` : `No unit counts given; assumed ${Object.entries(DEFAULT_UNITS).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  else {
    const missing = UNIT_ORDER.filter((u) => stated[u] === undefined && (u === 'usar' || u === 'truck'));
    if (missing.length) assumptions.push(zh ? `未提及 ${missing.join('/')}，按 0 计；重型救援由消防车承担` : `No ${missing.join('/')} mentioned; assumed none — engines do light rescue`);
  }

  const ctx: Ctx = { s, fac: new Map(s.facilities.map((f) => [f.id, f])), tt: new Map() };
  for (const t of s.travelTimes) {
    const l = ctx.tt.get(t.incidentId) ?? [];
    l.push(t);
    ctx.tt.set(t.incidentId, l);
  }
  // "If X Street is cleared" → treat roadMin null as reachable via that street (heuristic: no helicopter need).
  const clearedStreet = /(?:if|once|when)\s+([a-z0-9 .'-]+?)\s+(?:street|st\b|avenue|ave\b)?\s*(?:is|gets|were)\s+(?:cleared|opened|reopened)/i.exec(q)?.[1]?.trim();
  const clearedZh = /([一-鿿A-Za-z ]+?)(?:街|路|大道)?(?:被)?(?:清理|疏通|打通|清通)/.exec(q)?.[1]?.trim();

  const left = { ...units };
  const assignments: RescuePlan['assignments'] = [];
  const add = (u: UnitType, count: number, inc: RescueIncident, task: string) => {
    const n = Math.min(count, left[u]);
    if (n <= 0) return;
    const near = nearest(ctx, u, inc);
    if (!near) return;
    left[u] -= n;
    const prev = assignments.find((a) => a.unitType === u && a.incidentId === inc.id && a.fromFacilityId === near.f.id);
    if (prev) prev.count += n;
    else assignments.push({ unitType: u, count: n, fromFacilityId: near.f.id, incidentId: inc.id, task });
  };

  const T = (en: string, cn: string) => (zh ? cn : en);
  // 1. Verified trapped: USAR + truck + engine + ambulance; helicopter if unreachable / rooftop.
  for (const i of trapped.slice(0, 4)) {
    const reach = roadReachable(ctx, i);
    if (!reach) {
      add('helicopter', 1, i, T('hoist/rooftop rescue — no road access', '吊运/屋顶救援（道路不通）'));
      continue;
    }
    add('usar', 1, i, T('collapsed-structure search & rescue', '倒塌建筑搜救'));
    add('truck', 1, i, T('heavy rescue / forcible entry', '重型破拆救援'));
    add('engine', (i.peopleSeen ?? 0) >= 5 ? 2 : 1, i, T('light rescue, fire watch, first aid', '轻型救援、火情监护、现场急救'));
    add('ambulance', (i.peopleSeen ?? 0) >= 5 ? 2 : 1, i, T('patient transport to hospital', '伤员转运至医院'));
  }
  // 2. Verified fires.
  for (const i of fires.slice(0, 4)) {
    if (!roadReachable(ctx, i)) {
      add('helicopter', 1, i, T('aerial recon of fire spread', '空中侦察火势'));
      continue;
    }
    add('engine', i.damage === 'collapsed' || (i.occupants ?? 0) > 200 ? 3 : 2, i, T('fire suppression, protect exposures', '灭火并保护邻近建筑'));
  }
  // 3. Unverified suspected collapses: one light unit / recon each.
  const suspected = incidents.filter((i) => !i.verified || i.kind === 'suspected_collapse').slice(0, 3);
  for (const i of suspected) {
    if (left.helicopter > 0 && !roadReachable(ctx, i)) add('helicopter', 1, i, T('aerial recon to verify', '空中侦察核实'));
    else add('engine', 1, i, T('recon — verify before committing USAR', '先行侦察核实，再决定是否投入搜救队'));
  }
  // 4. Crowds + cordons (police).
  const crowds = incidents.filter((i) => i.kind === 'crowd').slice(0, 3);
  const roadsTop = topBlockedRoads(s, 3);
  const policeForRoads = Math.min(left.police, roadsTop.length * 3);
  let policeLeft = left.police - policeForRoads;
  for (const i of crowds) {
    const n = Math.min(policeLeft, 4);
    if (n > 0) {
      const before = left.police;
      add('police', n, i, T('crowd safety, keep access corridor open', '人群疏导，保持救援通道'));
      policeLeft -= before - left.police;
    }
  }
  for (const i of trapped.slice(0, 3)) {
    const n = Math.min(policeLeft, 2);
    if (n > 0) {
      const before = left.police;
      add('police', n, i, T('cordon + traffic control for ambulances', '警戒与救护车交通管制'));
      policeLeft -= before - left.police;
    }
  }
  // Remaining police: traffic control on the most-blocked corridors, attached to the top reachable trapped sites.
  for (let k = 0; k < trapped.length && left.police > 0; k++) {
    const i = trapped[k];
    if (!roadReachable(ctx, i)) continue;
    const road = roadsTop[k % Math.max(1, roadsTop.length)]?.name;
    add('police', Math.min(left.police, 3), i, road ? T(`traffic control, clear ${road} for ambulances`, `交通管制，疏通 ${road} 救护车通道`) : T('traffic control for ambulances', '救护车交通管制'));
  }
  // Leftover helicopters: people on damaged roofs (extensive, standing) first, else recon over the top site.
  for (const i of trapped) {
    if (left.helicopter <= 0) break;
    if (i.damage === 'extensive' && (i.peopleSeen ?? 0) > 0) add('helicopter', 1, i, T('rooftop hoist rescue of people on the roof', '屋顶人员吊运救援'));
  }
  // Spread leftover engines / ambulances / helicopters over the top sites.
  const top = [...trapped, ...fires].slice(0, 6);
  for (let k = 0; k < 20 && top.length && (left.engine > 0 || left.ambulance > 0); k++) {
    const i = top[k % top.length];
    if (!roadReachable(ctx, i)) continue;
    if (left.engine > 0) add('engine', 1, i, T('additional rescue / suppression', '增援救援/灭火'));
    if (left.ambulance > 0 && (i.kind === 'trapped' || i.trappedSigns)) add('ambulance', 1, i, T('patient transport to hospital', '伤员转运至医院'));
    if (k > 12) break;
  }
  if (left.helicopter > 0 && top[0]) add('helicopter', left.helicopter, top[0], T('aerial recon + medevac standby', '空中侦察及医疗后送待命'));

  const routeClearing: RescuePlan['routeClearing'] = roadsTop
    .filter((r) => r.verified + r.likely > 0)
    .map((r) => ({
      roadName: r.name,
      unitType: (units.police > 0 ? 'police' : 'truck') as UnitType,
      reason: zh ? `${r.verified} 段已核实堵塞${r.likely ? `、${r.likely} 段疑似堵塞` : ''}，打通救护车通道` : `${r.verified} verified blocked${r.likely ? ` + ${r.likely} likely` : ''} segments — reopen ambulance corridor`,
    }));

  const priorityIncidents = [...trapped.slice(0, 3), ...fires.slice(0, 2), ...suspected.slice(0, 1)].filter((v, k, a) => a.indexOf(v) === k).slice(0, 5);
  const priorities: RescuePlan['priorities'] = priorityIncidents.map((i, k) => ({
    rank: k + 1,
    incidentId: i.id,
    reason:
      i.kind === 'trapped' || i.trappedSigns
        ? T(`${i.peopleSeen ?? '?'} people seen, trapped signs, ${Math.round((i.confidence ?? 0) * 100)}% conf.`, `可见 ${i.peopleSeen ?? '?'} 人、有被困迹象，置信度 ${Math.round((i.confidence ?? 0) * 100)}%`)
        : i.fire || i.kind === 'fire'
          ? T(`active fire${i.occupants ? `, ~${Math.round(i.occupants)} occupants` : ''}`, `明火${i.occupants ? `，约 ${Math.round(i.occupants)} 名在内人员` : ''}`)
          : T(`unverified, P(destroyed) ${Math.round((i.pDestroyed ?? 0) * 100)}%, ~${Math.round(i.occupants ?? 0)} occupants`, `未核实，倒塌概率 ${Math.round((i.pDestroyed ?? 0) * 100)}%，约 ${Math.round(i.occupants ?? 0)} 人`),
  }));

  const eta = (i: RescueIncident) => {
    const a = assignments.find((x) => x.incidentId === i.id && x.unitType !== 'helicopter');
    const t = a && (ctx.tt.get(i.id) ?? []).find((r) => r.fromFacilityId === a.fromFacilityId);
    return t?.roadMin != null ? `${Math.round(t.roadMin)} min` : null;
  };
  const used = (u: UnitType) => units[u] - left[u];
  const lines = priorityIncidents.slice(0, 3).map((i, k) => `${k + 1}. ${label(i)} — ${priorities[k].reason}${eta(i) ? ` · ETA ${eta(i)}` : ''}`);
  const cleared = clearedStreet || clearedZh;
  const clearedLine = cleared
    ? zh
      ? `\n\n若 **${cleared}** 打通：原本道路不通的点可改由地面力量进入，直升机可转为医疗后送；警力可从该路段转去疏导人群。`
      : `\n\nIf **${cleared}** is cleared: sites that were road-unreachable can take ground units, helicopters shift to medevac, and the police on that corridor move to crowd control.`
    : '';
  const reply = zh
    ? `**前三优先：**\n${lines.join('\n') || '- 暂无核实的被困/火情点'}\n\n已核实被困点 ${trapped.length} 处（约 ${peopleTrapped} 人）、火情 ${fires.length} 处。派出：${UNIT_ORDER.filter((u) => used(u) > 0).map((u) => `${used(u)} ${u}`).join('、') || '无'}。${routeClearing.length ? `警力优先疏通 ${routeClearing.map((r) => r.roadName).join('、')}。` : ''}${suspected[0] ? `\n\n不确定：${suspected[0].id} 未核实，先派无人机/轻型力量复核再投入搜救队。` : ''}${clearedLine}`
    : `**Top 3 priorities:**\n${lines.join('\n') || '- No verified trapped/fire sites yet'}\n\n${trapped.length} verified trapped sites (~${peopleTrapped} people), ${fires.length} fires. Committing: ${UNIT_ORDER.filter((u) => used(u) > 0).map((u) => `${used(u)} ${u}`).join(', ') || 'none'}.${routeClearing.length ? ` Police clear ${routeClearing.map((r) => r.roadName).join(', ')} first.` : ''}${suspected[0] ? `\n\nUncertain: ${suspected[0].id} is unverified — send a drone/light unit before committing USAR.` : ''}${clearedLine}`;

  const reserve = UNIT_ORDER.filter((u) => left[u] > 0);
  if (reserve.length) assumptions.push(zh ? `预备队：${reserve.map((u) => `${left[u]} ${u}`).join('、')}` : `Held in reserve: ${reserve.map((u) => `${left[u]} ${u}`).join(', ')}`);

  return {
    reply,
    plan: { priorities, assignments, routeClearing, reassessInMinutes: 15, assumptions },
    model: 'mock-heuristic',
    mode: 'mock',
    latencyMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
  };
}
