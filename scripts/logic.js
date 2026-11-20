/**
 * Pure rules for layer 2 (saves and areas). Nothing here touches Foundry, so these functions
 * can be tested in Node (dev/unit-tests.mjs).
 */

export const SAVE_LABEL = { fort: "Fortitude", reflex: "Reflex", will: "Will" };

/** Natural 1 always fails a save, natural 20 always succeeds (CRB 241). */
export function saveSucceeds(nat, total, dc) {
    if (nat === 1) return false;
    if (nat === 20) return true;
    return total >= dc;
}

/**
 * What a successful save does to the damage, from sfrpg's save descriptor.
 * Explode weapons are always Reflex for half (CRB 181), whatever the data says.
 * onSave: "half" | "none" | "full". flagged rows get a note and Full/Half/None buttons on the GM card.
 */
export function saveEffect(descriptor, { explode = false } = {}) {
    if (explode) return { onSave: "half", flagged: false, note: "" };
    switch (descriptor) {
        case "half": return { onSave: "half", flagged: false, note: "" };
        case "negate":
        case "disbelieve": return { onSave: "none", flagged: false, note: "" };
        case "partial": return { onSave: "half", flagged: true, note: "partial: check the effect" };
        case "object":
        case "harmless": return { onSave: "full", flagged: false, note: "", noSave: true };
        default: return { onSave: "half", flagged: true, note: "no save descriptor: check the effect" };
    }
}

/**
 * The share of the damage one target takes.
 * evasion: null | "evasion" | "improved". It works only against Reflex saves for half damage:
 * a success takes nothing, and with improved evasion a failure takes half.
 */
export function damageFactor({ saved, onSave, evasion = null, isReflex = false }) {
    const evades = !!evasion && isReflex && onSave === "half";
    if (saved) {
        if (evades) return { factor: 0, evaded: "evasion" };
        if (onSave === "half") return { factor: 0.5 };
        if (onSave === "none") return { factor: 0 };
        return { factor: 1 };
    }
    if (evades && evasion === "improved") return { factor: 0.5, evaded: "improved" };
    return { factor: 1 };
}

/** Apply a factor to a rolled amount; halves round down. */
export function scaled(amount, factor) {
    if (factor === 1) return amount;
    if (!factor) return 0;
    return Math.floor(amount * factor);
}

/**
 * Range penalty for a distance (CRB 245): -2 per full increment past the first (-1 with Far Shot),
 * maximum 10 increments (thrown 5). A target at exactly one increment is inside the first.
 */
export function rangePenaltyFor(distance, increment, { thrown = false, farShot = false } = {}) {
    const maxIncrements = thrown ? 5 : 10;
    const increments = Math.max(1, Math.ceil(distance / increment));
    const per = farShot ? 1 : 2;
    const penalty = -per * (increments - 1) + 0;
    return { distance, increment, increments, penalty, outOfRange: increments > maxIncrements, maxRange: increment * maxIncrements, farShot };
}

/**
 * Where a missed thrown area weapon lands (CRB 245): 1d8 for direction, where 1 falls short
 * (toward the thrower) and 2 to 8 go clockwise around the aimed point, then 1d4 squares.
 * Points are in screen coordinates (y down), so clockwise is increasing angle.
 * Returns the move in grid squares.
 */
export function scatterStep(aimPoint, throwerPoint, d8, d4) {
    const dy = throwerPoint.y - aimPoint.y;
    const dx = throwerPoint.x - aimPoint.x;
    const toward = (dx === 0 && dy === 0) ? 2 : Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    const eighth = (((toward + (d8 - 1)) % 8) + 8) % 8;
    const a = eighth * Math.PI / 4;
    return { di: Math.round(Math.cos(a)) * d4 + 0, dj: Math.round(Math.sin(a)) * d4 + 0, eighth };
}

const COMPASS = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
export const compass = (eighth) => COMPASS[eighth] ?? "";

/** The first "N ft" in a piece of text, or null. */
export function feetIn(text) {
    const m = String(text ?? "").match(/(\d+)\s*-?\s*(?:ft|feet|foot)\b/i);
    return m ? Number(m[1]) : null;
}

const SHAPE_TO_TEMPLATE = { sphere: "circle", cylinder: "circle", cone: "cone", cube: "rect", line: "ray" };
export const TEMPLATE_TO_SHAPE = { circle: "sphere", cone: "cone", rect: "cube", ray: "line" };

/**
 * The area an item covers, from its data and weapon properties (sfrpg's data often leaves the
 * area blank on area weapons). Returns null when the item has no area.
 * kind: "explode" | "blast" | "line" | "automatic" | "area"; t: Foundry template type; distance in ft.
 */
export function areaSpec(sys, { autoMode = false, description = "" } = {}) {
    const p = sys?.properties ?? {};
    const on = (k) => !!p[k]?.value;
    const area = sys?.area ?? {};
    const areaFt = Number(area.total) || Number(area.value) || 0;
    const metric = area.units === "meter";
    const areaDist = metric ? 0 : areaFt;
    const inc = sys?.range?.units === "ft" ? (Number(sys?.range?.value) || 0) : 0;

    if (on("explode")) {
        const radius = areaDist || feetIn(p.explode?.extension) || feetIn(description.match(/explode\s*\(([^)]*)\)/i)?.[1]);
        return radius ? { kind: "explode", t: "circle", distance: radius } : { kind: "explode", t: "circle", distance: 5, guessed: true };
    }
    if (on("blast")) {
        const d = (area.shape === "cone" && areaDist) || inc || areaDist;
        return d ? { kind: "blast", t: "cone", distance: d } : null;
    }
    if (on("line")) {
        const d = (area.shape === "line" && areaDist) || inc || areaDist;
        return d ? { kind: "line", t: "ray", distance: d } : null;
    }
    if (on("automatic") && autoMode && inc) {
        return { kind: "automatic", t: "cone", distance: Math.max(5, Math.floor(inc / 2 / 5) * 5) };
    }
    const t = SHAPE_TO_TEMPLATE[area.shape];
    if (t && areaDist > 0) return { kind: "area", t, distance: areaDist };
    return null;
}

/**
 * A damage part that is really ability damage ("Strength damage", "Dexterity drain"): untyped and
 * named for an ability score. It isn't taken off Stamina or HP; the GM card shows it to apply by hand.
 */
export function isAbilityDamagePart(part) {
    const typed = Object.values(part?.types ?? {}).some(Boolean);
    if (typed) return false;
    return /\b(strength|dexterity|constitution|intelligence|wisdom|charisma)\b.*\b(damage|drain)\b/i.test(String(part?.name ?? ""));
}

/** A damage part that heals (sfrpg's "healing" type). The module leaves healing to sfrpg. */
export const isHealingPart = (part) => !!part?.types?.healing;

/** How a damage part is named in the module's "which damage?" prompt. */
export function partName(part, i) {
    if (part?.name) return String(part.name);
    const types = Object.entries(part?.types ?? {}).filter(([, on]) => on).map(([k]) => k).join(" & ");
    const formula = String(part?.formula ?? "");
    return [types, formula.length <= 24 ? formula : ""].filter(Boolean).join(" ") || `Part ${i + 1}`;
}

/**
 * Immune to mind-affecting effects: undead and constructs (CRB), or a creature whose condition
 * immunities name them ("Undead Immunities", "Construct Immunities", "mind-affecting").
 */
export function mindImmune({ type = "", ci = [], ciCustom = "" } = {}) {
    if (/\b(undead|construct)\b/i.test(String(type))) return true;
    if ((ci ?? []).some(c => /mind/i.test(String(c)))) return true;
    return /undead immunit|construct immunit|mind-affecting/i.test(String(ciCustom ?? ""));
}

/** Remove save DCs from text players can see ("Save DC 15 Reflex half", "Crush Skull (DC 25)"). */
export function stripDCs(text) {
    return String(text ?? "")
        .replace(/\s*\(DC\s*\d+\)/gi, "")
        .replace(/\bDC\s*\d+\s*/gi, "");
}
