import { KINETIC, ENERGY, COVER, RESULT } from "./constants.js";
import { getSetting } from "./settings.js";
import { rangePenaltyFor } from "./logic.js";

/** The damage types an item deals, as a flat list (e.g. ["fire", "piercing"]) plus the operator. */
export function itemDamageTypes(item) {
    const types = new Set();
    let operator = "and";
    for (const part of item.system?.damage?.parts ?? []) {
        for (const [type, on] of Object.entries(part.types ?? {})) if (on) types.add(type);
        if (part.operator === "or") operator = "or";
    }
    return { types: [...types], operator };
}

/**
 * Which defense the attack targets. The item's own setting comes first; with none set,
 * kinetic damage (alone or mixed with energy) targets KAC and energy-only targets EAC (CRB 240).
 * Returns "kac" | "eac" | "kac8" | "ac5" | "ac15" | "other".
 */
export function pickAcKey(item) {
    const set = item.system?.actionTarget;
    if (["kac", "eac", "kac8", "ac5", "ac15", "other"].includes(set)) return set;
    const { types } = itemDamageTypes(item);
    if (types.some(t => KINETIC.includes(t))) return "kac";
    if (types.some(t => ENERGY.includes(t))) return "eac";
    return "kac";
}

export const AC_LABEL = { kac: "KAC", eac: "EAC", kac8: "KAC+8", ac5: "AC 5", ac15: "AC 15", other: "Other" };

/** The target's value for that defense, or null. */
export function baseAc(actor, acKey) {
    const a = actor?.system?.attributes ?? {};
    switch (acKey) {
        case "kac": return a.kac?.value ?? null;
        case "eac": return a.eac?.value ?? null;
        case "kac8": return a.cmd?.value || (a.kac?.value != null ? a.kac.value + 8 : null);
        case "ac5": return 5;
        case "ac15": return 15;
        default: return null;
    }
}

/** "melee" or "ranged" (or null for things that are neither). */
export function attackKind(item) {
    const at = item.system?.actionType;
    if (at === "mwak" || at === "msak") return "melee";
    if (at === "rwak" || at === "rsak") return "ranged";
    return null;
}

export function hasCondition(actor, name) {
    try {
        if (!CONFIG.SFRPG.statusEffects.find(e => e.id === name)) return false;
        return !!actor?.getCondition?.(name);
    } catch {
        return false;
    }
}

/** The natural result of the kept d20 (works with 2d20kh/kl). */
export function naturalD20(roll) {
    const die = roll?.dice?.find(d => d.faces === 20);
    if (!die) return null;
    const kept = die.results.filter(r => r.active !== false && !r.discarded);
    return kept[0]?.result ?? null;
}

/** The grid squares a token covers, as canvas points (centers). */
function tokenSquareCenters(token) {
    const doc = token.document;
    try {
        const offsets = doc.getOccupiedGridSpaceOffsets?.();
        if (offsets?.length) return offsets.map(o => canvas.grid.getCenterPoint(o));
    } catch { /* fall through */ }
    return [token.center];
}

/** Distance in feet between the nearest squares of two tokens. */
export function tokenDistance(a, b) {
    if (!a || !b || !canvas?.grid) return null;
    const pa = tokenSquareCenters(a);
    const pb = tokenSquareCenters(b);
    let best = Infinity;
    for (const p of pa) {
        for (const q of pb) {
            const d = canvas.grid.measurePath([p, q]).distance;
            if (d < best) best = d;
        }
    }
    return Number.isFinite(best) ? best : null;
}

/** Fewest squares between two tokens' nearest squares (king's moves), or null off a square grid. */
function squareGap(a, b) {
    if (!canvas?.grid?.isSquare) return null;
    try {
        const oa = a.document.getOccupiedGridSpaceOffsets?.() ?? [];
        const ob = b.document.getOccupiedGridSpaceOffsets?.() ?? [];
        if (!oa.length || !ob.length) return null;
        let best = Infinity;
        for (const p of oa) for (const q of ob) best = Math.min(best, Math.max(Math.abs(p.i - q.i), Math.abs(p.j - q.j)));
        return Number.isFinite(best) ? best : null;
    } catch {
        return null;
    }
}

const TINY_SIZES = ["fine", "diminutive", "tiny"];
const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean).map(w => w.replace(/s$/, ""));

/**
 * The attacker's reach with this item, in feet. sfrpg stores the actor's reach as text
 * ("5", "10 ft.", "5 ft. (10 ft. with tactical pike)"); a named exception applies when every
 * word of it is in the weapon's name. A weapon with the reach property reaches at least 10 ft.
 * A stored 0 counts only for Tiny and smaller creatures (many Medium NPCs have a 0 by mistake).
 */
export function attackerReach(item, actor) {
    const text = String(actor?.system?.attributes?.reach ?? "").trim();
    let reach = null;
    const base = text.match(/^(\d+)/);
    if (base) reach = Number(base[1]);
    const itemWords = new Set(words(item?.name));
    for (const m of text.matchAll(/\((\d+)\s*ft\.?\s*with\s+([^)]+)\)/gi)) {
        const need = words(m[2]);
        if (need.length && need.every(w => itemWords.has(w))) reach = Number(m[1]);
    }
    const size = actor?.system?.traits?.size;
    if (reach === 0 && !TINY_SIZES.includes(size)) reach = null;
    if (reach == null) reach = TINY_SIZES.includes(size) ? 0 : 5;
    if (item?.system?.properties?.reach?.value) reach = Math.max(reach, 10);
    return reach;
}

/**
 * Melee reach check (a warning only; the attack still resolves). 10-ft reach also reaches
 * the second square of a diagonal (CRB 255); every other reach measures normally.
 * Returns null when it doesn't apply.
 */
export function reachInfo(item, attackerToken, targetToken) {
    if (attackKind(item) !== "melee" || !attackerToken || !targetToken) return null;
    const distance = tokenDistance(attackerToken, targetToken);
    if (distance == null) return null;
    const reach = attackerReach(item, attackerToken.actor ?? item.actor);
    let inReach = distance <= reach;
    if (!inReach && reach === 10) {
        const gap = squareGap(attackerToken, targetToken);
        if (gap != null && gap <= 2) inReach = true;
    }
    return { distance, reach, outOfReach: !inReach };
}

/** A spell or ability's flat range in feet: "ft" ranges, or sfrpg's close/medium/long totals. */
export function flatRange(item) {
    const range = item?.system?.range ?? {};
    if (range.units === "ft") return Number(range.total) || Number(range.value) || null;
    if (["close", "medium", "long"].includes(range.units)) {
        const total = Number(range.total)
            || Number(item?.actor?.system?.spells?.range?.[range.units]);
        return total || null;
    }
    return null;
}

/**
 * Range penalty for a ranged weapon attack. Weapons: -2 per full increment past the first
 * (-1 with Far Shot); max 10 increments (thrown 5). Spells and other ranged attacks have a flat
 * range (close, medium and long from sfrpg's totals). Returns null when range doesn't apply.
 */
export function rangeInfo(item, attackerToken, targetToken, { distance = null } = {}) {
    if (!getSetting("rangePenalties")) return null;
    if (attackKind(item) !== "ranged") return null;
    const range = item.system?.range ?? {};

    if (item.type !== "weapon") {
        const flat = flatRange(item);
        if (!flat) return null;
        const d = distance ?? tokenDistance(attackerToken, targetToken);
        if (d == null) return null;
        return { distance: d, increment: flat, increments: 1, penalty: 0, outOfRange: d > flat, maxRange: flat, flat: true };
    }
    const increment = Number(range.value);
    if (!(range.units === "ft" && increment > 0)) return null;
    const d = distance ?? tokenDistance(attackerToken, targetToken);
    if (d == null) return null;
    const thrown = !!item.system?.properties?.thrown?.value;
    const farShot = hasFarShot(item.actor);
    return rangePenaltyFor(d, increment, { thrown, farShot });
}

export function hasFarShot(actor) {
    return !!actor?.items?.find(i => i.type === "feat" && /^far shot$/i.test(i.name.trim()));
}

/** Out-of-range warning for save spells aimed at targets (the GM card shows it; nothing is blocked). */
export function saveRangeWarning(item, attackerToken, targetToken) {
    const flat = flatRange(item);
    if (!flat || !attackerToken || !targetToken) return null;
    const d = tokenDistance(attackerToken, targetToken);
    if (d == null || d <= flat) return null;
    return { distance: d, range: flat };
}

/**
 * Resolve one attack roll against one target.
 * @returns per-target result object (no damage yet).
 */
export function resolveTarget({ item, roll, attackerToken, targetToken, cover = "none",
    total: totalOverride = null, nat: natOverride = null, penalty = 0, penaltyLabel = "", noCrit = false, skipRange = false }) {
    const actor = targetToken.actor;
    const acKey = pickAcKey(item);
    const kind = attackKind(item);
    const nat = natOverride ?? naturalD20(roll);
    const total = totalOverride ?? roll.total;

    const out = {
        tokenUuid: targetToken.document.uuid,
        actorUuid: actor?.uuid,
        name: targetToken.document.name,
        img: targetToken.document.texture?.src,
        acKey, kind, nat, rollTotal: total,
        cover, coverBonus: 0, proneAdj: 0, helplessBonus: 0,
        range: null, notes: []
    };

    const ac = baseAc(actor, acKey);
    out.baseAc = ac;
    if (ac == null) {
        out.result = RESULT.MANUAL;
        out.notes.push(acKey === "other" ? "attack targets something other than AC" : "no AC on target");
        return out;
    }

    const cov = COVER[cover] ?? COVER.none;
    if (cover === "total") {
        out.result = RESULT.BLOCKED;
        out.notes.push("total cover");
        out.effTotal = total; out.effAc = ac;
        return out;
    }
    out.coverBonus = cov.ac;
    if (cov.ac) out.notes.push(`${cov.short.toLowerCase()} cover +${cov.ac}`);

    if (hasCondition(actor, "prone") && kind) {
        out.proneAdj = kind === "ranged" ? 4 : -4;
        out.notes.push(`prone ${out.proneAdj > 0 ? "+" : ""}${out.proneAdj} vs ${kind}`);
    }
    if (hasCondition(actor, "helpless") && kind === "melee") {
        out.helplessBonus = 4;
        out.notes.push("helpless: melee +4");
    }

    out.reach = reachInfo(item, attackerToken, targetToken);

    const r = skipRange ? null : rangeInfo(item, attackerToken, targetToken);
    out.range = r;
    let rangePenalty = 0;
    if (r) {
        rangePenalty = r.penalty;
        if (r.penalty) out.notes.push(`range ${r.distance} ft: ${r.penalty}${r.farShot ? " (Far Shot)" : ""}`);
    }

    out.areaPenalty = penalty;
    if (penalty) out.notes.push(`${penaltyLabel} ${penalty}`.trim());
    out.effTotal = total + rangePenalty + out.helplessBonus + penalty;
    out.effAc = ac + out.coverBonus + out.proneAdj;

    if (r?.outOfRange) {
        out.result = RESULT.BLOCKED;
        out.notes.push(`out of range (max ${r.maxRange} ft)`);
        return out;
    }

    const meets = out.effTotal >= out.effAc;
    if (nat === 1) out.result = RESULT.MISS;
    else if (nat === 20) out.result = meets && !noCrit ? RESULT.CRIT : RESULT.HIT;
    else out.result = meets ? RESULT.HIT : RESULT.MISS;
    if (nat === 20 && !meets) out.notes.push("natural 20: hits, no crit");
    else if (nat === 20 && noCrit) out.notes.push("natural 20: hits, can't crit here");
    if (nat === 1) out.notes.push("natural 1");
    return out;
}
