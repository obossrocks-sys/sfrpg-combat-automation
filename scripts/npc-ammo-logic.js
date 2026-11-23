/**
 * v0.5.0: the pure part of NPC ammunition (no Foundry needed; unit-tested in dev/unit-tests.mjs).
 * Which compendium weapon an NPC's weapon is, which ammunition it takes, how many spare loads it
 * carries, and what a stat block's ammo "goods" lines mean.
 */

/** A name reduced to letters and digits, with any parenthetical dropped. */
export const norm = (s) => String(s ?? "").toLowerCase().replace(/\([^)]*\)?/g, "").replace(/[^a-z0-9]/g, "");

/**
 * The compendium weapon an NPC weapon came from: same name, or the longest compendium name that the
 * NPC's name contains ("Underwater Zero Pistol, Frostbite-Class" is a zero pistol, frostbite-class).
 * packWeapons: [{ name, ... }].
 */
export function matchWeapon(name, packWeapons) {
    const n = norm(name);
    if (!n) return null;
    let best = null;
    for (const w of packWeapons) {
        const m = norm(w.name);
        if (!m) continue;
        if (m === n) return w;
        if (m.length >= 8 && n.includes(m) && (!best || m.length > norm(best.name).length)) best = w;
    }
    return best;
}

/** Integrated weapons (robots and the like) have no ammunition to track. */
export const isIntegrated = (weaponName, featNames = []) =>
    /^integrated\b/i.test(String(weaponName ?? "").trim()) || featNames.some(f => /^integrated weapons\b/i.test(String(f).trim()));

/** Special or faction ammunition never chosen as an NPC's ordinary load. */
const SPECIAL = /^(explosive|warpshot|kishalee|rel-battery|swarm|mi-go|grenade arrow|plasma missile|advanced missile)/i;

/**
 * The ordinary ammunition for a type. Batteries, tanks and other charge packs: the largest that fits
 * the weapon's capacity (sfrpg's reload only loads one that fits). Cartridges: the lowest level.
 * ammo: [{ name, ammunitionType, useCapacity, capacityMax, level, quantity }].
 */
export function pickAmmo(type, capMax, ammo) {
    if (!type) return null;
    const all = ammo.filter(a => a.ammunitionType === type);
    const plain = all.filter(a => !SPECIAL.test(a.name));
    const pool = plain.length ? plain : all;
    if (!pool.length) return null;
    const packs = pool.filter(a => a.useCapacity);
    if (packs.length) {
        const fit = packs.filter(a => (Number(a.capacityMax) || 0) <= (Number(capMax) || 0));
        if (!fit.length) return null;
        return fit.sort((a, b) => (b.capacityMax - a.capacityMax) || (a.level - b.level))[0];
    }
    return [...pool].sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name))[0];
}

/** The charge pack of one size for a type ("Battery, High-Capacity" for 40), or null. */
export function packOfSize(type, size, ammo) {
    return ammo.filter(a => a.ammunitionType === type && a.useCapacity && Number(a.capacityMax) === Number(size) && !SPECIAL.test(a.name))
        .sort((a, b) => a.level - b.level)[0] ?? null;
}

/** Spare loads when the stat block lists none: 2 for small arms, longarms and sniper weapons, 1 otherwise. */
export const defaultSpareLoads = (weaponType) => (["smallA", "longA", "sniper"].includes(weaponType) ? 2 : 1);

/**
 * A stat block's ammunition "goods" line, or null.
 * "2 High-Capacity Batteries (40 Charges Each" → { type: "charge", size: 40, count: 2 }
 * "4 Magazines (100 Longarm Rounds" → { type: "roundL", rounds: 100 }
 * "Rounds, Small Arm" (quantity 1) → { type: "roundS", rounds: null, packs: 1 } (quantity 400 → rounds: 400)
 * "15 Rounds" → { type: null, rounds: 15 } (the type comes from the NPC's weapon)
 */
export function parseGoodsAmmo(name, quantity = 1) {
    const n = String(name ?? "").toLowerCase();
    const q = Math.max(1, Number(quantity) || 1);
    const lead = n.match(/^\s*(\d+)\s/);
    const paren = n.match(/\((\d+)\s/);
    if (/\bbatter(y|ies)\b/.test(n)) {
        let size = /ultra/.test(n) ? 100 : /super/.test(n) ? 80 : /high/.test(n) ? 40 : 20;
        const ch = n.match(/(\d+)\s*charges?/);
        if (ch) size = Number(ch[1]);
        return { type: "charge", size, count: lead ? Number(lead[1]) : q };
    }
    if (/\bpetrol\b/.test(n)) return { type: "fuel", size: /high/.test(n) ? 40 : 20, count: lead ? Number(lead[1]) : q };
    const cart = [
        [/\b(rounds?|magazines?)\b/, n.match(/long-?arm|sniper/) ? "roundL" : /small/.test(n) ? "roundS" : /heavy/.test(n) ? "roundH" : null],
        [/\bdarts?\b/, "dart"], [/\barrows?\b/, "arrow"], [/\bshells?\b/, "shell"], [/\bflechettes?\b/, "flechettes"]
    ];
    for (const [re, type] of cart) {
        if (!re.test(n)) continue;
        // No number in the name: a quantity of 10 or more is a count of rounds, a smaller one of boxes.
        const rounds = paren ? Number(paren[1]) : lead ? Number(lead[1]) : q >= 10 ? q : null;
        return rounds ? { type, rounds } : { type, rounds: null, packs: q };
    }
    return null;
}

/** Can a spare reload this weapon? Mirrors sfrpg's reload(): a charge pack with more charges that fits, or any cartridges. */
export function spareFits(spare, weapon) {
    if (!spare || spare.ammunitionType !== weapon.ammunitionType) return false;
    if (spare.useCapacity) return spare.current > weapon.current && spare.capacityMax <= weapon.capacityMax;
    return spare.current > 0;
}

/**
 * Goods lines that repeat another: when one line names the ammunition item exactly (the importer's
 * line, "Rounds, Longarm and Sniper" ×400), a free-text line for the same item ("4 Magazines (100
 * Longarm Rounds") describes the same ammunition. Returns the indexes to drop.
 * list: [{ name, targetId, targetName }].
 */
export function duplicateGoods(list) {
    const exact = new Set(list.filter(g => norm(g.name) === norm(g.targetName)).map(g => g.targetId));
    return list.map((g, i) => (exact.has(g.targetId) && norm(g.name) !== norm(g.targetName) ? i : -1)).filter(i => i >= 0);
}
