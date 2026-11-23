/**
 * Layer 3, the pure rules: which conditions an item inflicts, for how long, and what a critical
 * hit effect does (CRB 182-183, Armory 26). No Foundry calls here, so dev/unit-tests.mjs runs them.
 *
 * Where sfrpg keeps the data:
 *  - explode weapons and grenades: system.chatFlavor ("blinded [[1d4]] rounds", "burning 1d4");
 *  - spells and abilities: condition links in the description (@UUID[...conditions...]{Dazed}),
 *    with the duration in system.duration ({ units: "round", value: "@details.cl.value" });
 *  - critical hit effects: system.critical.effect ("Burn 1d6", "Staggered", "Arc 1d6").
 */

export const CONDITIONS = [
    "asleep", "bleeding", "blinded", "broken", "burning", "confused", "cowering", "dazed", "dazzled",
    "dead", "deafened", "dying", "encumbered", "entangled", "exhausted", "fascinated", "fatigued",
    "flat-footed", "frightened", "grappled", "helpless", "invisible", "nauseated", "off-kilter",
    "off-target", "overburdened", "panicked", "paralyzed", "pinned", "prone", "shaken", "sickened",
    "stable", "staggered", "stunned", "unconscious"
];

/** Conditions an attack or effect never hands out through this layer. */
const NOT_INFLICTED = new Set(["broken", "dead", "dying", "stable", "encumbered", "overburdened", "invisible"]);

const UNITS = { round: "round", rounds: "round", minute: "minute", minutes: "minute", hour: "hour", hours: "hour", day: "day", days: "day" };
const DICE = String.raw`\d+d\d+(?:\s*[+-]\s*\d+)?|\d+`;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const COND_RE = new RegExp(String.raw`(?<![\w-])(${CONDITIONS.map(escRe).join("|")})(?![\w-])`, "g");

/** Turn sfrpg's markup into plain lowercase text: inline rolls, condition links, HTML. */
export function plainEffectText(text) {
    return String(text ?? "")
        .replace(/\[\[\/r[^\]]*\]\]\{([^}]*)\}/gi, "$1")
        .replace(/\[\[\/?r?\s*([^\]]*)\]\]/gi, "$1")
        .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim();
}

/** A duration right after a condition: "1d4 rounds", "for 1 round", "(2d4 rounds)". */
export function durationAfter(after) {
    const m = after.match(new RegExp(String.raw`^[\s,(]*(?:for\s+)?(${DICE})\s*(rounds?|minutes?|hours?|days?)\b`));
    return m ? { formula: m[1].replace(/\s/g, ""), unit: UNITS[m[2]] } : null;
}

/**
 * Conditions named in an effect text (an explode weapon's chatFlavor). Each comes with the
 * duration written after it, if any, and for burning and bleeding the damage ("burning 1d4").
 */
export function parseEffectText(text) {
    const clean = plainEffectText(text);
    const out = [];
    for (const m of clean.matchAll(COND_RE)) {
        const cond = m[1];
        if (NOT_INFLICTED.has(cond) || out.some(e => e.cond === cond)) continue;
        const after = clean.slice(m.index + cond.length, m.index + cond.length + 40);
        const dur = durationAfter(after);
        let amount = null;
        if (!dur && (cond === "burning" || cond === "bleeding")) {
            const a = after.match(new RegExp(String.raw`^[\s(]*(${DICE})(?!\s*(?:rounds?|minutes?|hours?|days?)\b)`));
            if (a) amount = a[1].replace(/\s/g, "");
        }
        out.push({ cond, dur, amount });
    }
    return out;
}

/** Condition links in a description, in order, once each (spells and abilities). */
export function linkedConditions(description) {
    const out = [];
    const re = /@UUID\[Compendium\.sfrpg\.conditions\.Item\.[^\]]+\]\{([^}]+)\}/g;
    for (const m of String(description ?? "").matchAll(re)) {
        const cond = m[1].trim().toLowerCase();
        if (CONDITIONS.includes(cond) && !NOT_INFLICTED.has(cond) && !out.includes(cond)) out.push(cond);
    }
    return out;
}

/** "Each round on its turn, the target can attempt a new saving throw" (hold person and the like). */
export const allowsNewSave = (description) => /new sav(e|ing throw)/i.test(plainEffectText(description));

/**
 * Which conditions an item inflicts on a failed save. Explode weapons, grenades and other items
 * with an effect line read it from chatFlavor; anything else (spells, abilities) from condition
 * links in its description, using the item's own duration. Returns { list, source, resave }.
 */
export function effectsFromItem({ chatFlavor = "", description = "", spellDuration = null } = {}) {
    let list = parseEffectText(chatFlavor);
    let source = list.length ? "flavor" : "none";
    if (!list.length) {
        const plain = plainEffectText(description);
        list = linkedConditions(description).map(cond => {
            const i = plain.indexOf(cond);
            const dur = i >= 0 ? durationAfter(plain.slice(i + cond.length, i + cond.length + 40)) : null;
            return { cond, dur: dur ?? spellDuration, amount: null };
        });
        if (list.length) source = "links";
    }
    // A staggered with no duration (riot and cryo grenades): 1 round, as the staggered critical
    // effect (CRB 182). Prone, burning and bleeding last until removed.
    for (const e of list) {
        if (!e.dur && e.cond === "staggered") e.dur = { formula: "1", unit: "round", assumed: true };
    }
    return { list, source, resave: source === "links" && allowsNewSave(description) };
}

/** sfrpg's duration field as a duration, when it's a plain count (value may need roll data). */
export function spellDurationField(duration) {
    const unit = UNITS[String(duration?.units ?? "").toLowerCase()] ?? UNITS[`${String(duration?.units ?? "").toLowerCase()}s`];
    const value = String(duration?.value ?? "").trim();
    if (!unit || !value) return null;
    return { formula: value, unit };
}

/* ---------- critical hit effects ---------- */

/**
 * The critical hit effects (CRB 182-183; Armory 26). kind:
 *  cond      apply a condition (save: the save that negates it; perLevel: 1 round per item level)
 *  ongoing   damage at the start of each turn, as burning (corrode is burning with acid; CRB 182)
 *  secondary damage to another creature (arc: the nearest within 10 ft of the target)
 *  pulse     damage to every creature adjacent to the target
 *  wound     a d20 on the wounding table (CRB Table 7-1); severe wound rolls twice
 *  note      shown to the GM with the DC
 */
export const CRIT_RULES = {
    "arc": { kind: "secondary", reach: 10, nearest: true },
    "second arc": { kind: "secondary", reach: 10, nearest: true, second: true },
    "jet": { kind: "secondary", reach: 5, nearest: false },
    "pulse": { kind: "pulse" },
    "bleed": { kind: "ongoing", cond: "bleeding", type: null, immune: "bleed" },
    "burn": { kind: "ongoing", cond: "burning", type: "fire" },
    "corrode": { kind: "ongoing", cond: null, type: "acid", label: "Corrode" },
    "knockdown": { kind: "cond", cond: "prone" },
    "stunned": { kind: "cond", cond: "stunned", dur: { formula: "1", unit: "round" }, immune: "stun" },
    "staggered": { kind: "cond", cond: "staggered", save: "fort", dur: { formula: "1", unit: "round" } },
    "blind": { kind: "cond", cond: "blinded", save: "reflex", dur: { formula: "1d3", unit: "round" } },
    "deafen": { kind: "cond", cond: "deafened", save: "fort", dur: { formula: "1d4", unit: "minute" } },
    "sicken": { kind: "cond", cond: "sickened", save: "fort", dur: { formula: "1d4", unit: "minute" }, immune: "disease" },
    "nauseate": { kind: "cond", cond: "nauseated", save: "fort", dur: { formula: "1", unit: "round" } },
    "confuse": { kind: "cond", cond: "confused", save: "will", dur: { formula: "1", unit: "round" } },
    "fatigue": { kind: "cond", cond: "fatigued", save: "fort", perLevel: true },
    "leech": { kind: "cond", cond: "off-kilter", save: "fort", perLevel: true, immune: "disease" },
    "bind": { kind: "cond", cond: "entangled", escape: true },
    "wound": { kind: "wound", rolls: 1 },
    "severe wound": { kind: "wound", rolls: 2 },
    "push": { kind: "note", text: "Push {amount}: move the target away from the attacker; if it hits an obstacle it stops and falls prone" },
    "injection dc": { kind: "note", text: "The injected substance's DC is 2 higher" },
    "demoralize": { kind: "note", text: "The attacker can try Intimidate (−5) as a reaction to demoralize each creature this attack damaged" },
    "irradiate": { kind: "note", text: "Fortitude DC {dc} or radiation sickness (low-level radiation)" },
    "embed": { kind: "note", text: "Embedded: {amount} damage the first time each round it moves 5 ft or more; a standard action pulls it out (taking the damage), or Medicine DC 15 + 1½ × item level" },
    "suffocate": { kind: "note", text: "Drains environmental protection (half item level in days); with none left, Fortitude DC {dc} or exhausted" },
    "stifle": { kind: "note", text: "The target can't speak or make sounds for 1 round" }
};

/** sfrpg's spellings and typos for the same effects. */
const CRIT_ALIASES = { "staggared": "staggered", "stun": "stunned", "blinded": "blind", "deafened": "deafen", "knock down": "knockdown", "injection": "injection dc", "severe": "severe wound", "sickened": "sicken", "nauseated": "nauseate", "confused": "confuse" };

/**
 * Split a critical effect field into effects: "Burn 1d6", "Arc 1d6, knockdown", "Push (5 ft.)",
 * "Injection DC +2", "staggered [Fort]". Unknown words come back as kind "unknown".
 */
export function parseCrit(text) {
    const out = [];
    const raw = String(text ?? "").replace(/<[^>]*>/g, " ").replace(/\[\[\/?r?\s*([^\]]*)\]\]/g, "$1").trim();
    if (!raw || raw === "—" || raw === "-") return out;
    for (const piece of raw.split(/[,;]| and |\+(?=\s*[a-z])/i)) {
        const p = piece.trim();
        if (!p) continue;
        const lower = p.toLowerCase().replace(/\[[^\]]*\]/g, "").trim();
        const amount = (lower.match(new RegExp(String.raw`(${DICE})(?!\s*ft)`)) ?? [])[1]?.replace(/\s/g, "") ?? null;
        const distance = (lower.match(/(\d+)\s*(?:ft|feet)/) ?? [])[1] ?? null;
        let name = lower.replace(/\(.*?\)/g, "").replace(new RegExp(String.raw`(${DICE})`, "g"), "").replace(/[+]/g, "").replace(/\s+/g, " ").trim();
        if (name.startsWith("injection")) name = "injection dc";
        name = CRIT_ALIASES[name] ?? name;
        const rule = CRIT_RULES[name];
        out.push({ key: rule ? name : "unknown", raw: p, amount: name === "push" ? (distance ? `${distance} ft` : null) : amount, distance, rule: rule ?? null });
    }
    return out;
}

/** Critical hit and special property DC (CRB 181): 10 + half item level + the attack's ability modifier + penalties. */
export const critSaveDC = (itemLevel, abilityMod, penalties = 0) => 10 + Math.floor((Number(itemLevel) || 0) / 2) + (Number(abilityMod) || 0) + (Number(penalties) || 0);

/* ---------- immunities and durations ---------- */

/** Immunity words in a creature's condition immunities (traits.ci) and its type (AA1 158, 154). */
export function immuneTo({ type = "", ci = [], ciCustom = "" } = {}, what) {
    const t = String(type).toLowerCase();
    const custom = String(ciCustom).toLowerCase();
    const list = (ci ?? []).map(c => String(c).toLowerCase());
    if (list.includes(what)) return true;
    const undead = t.includes("undead") || custom.includes("undead immunit");
    const construct = t.includes("construct") || custom.includes("construct immunit");
    // Undead: bleed, death effects, disease, mind-affecting, paralysis, poison, sleep, stunning.
    // Constructs: the same list, plus ability damage and nonlethal (AA1 154).
    const typeImmune = { bleed: true, disease: true, paralyzed: true, paralysis: true, stun: true, stunned: true, asleep: true, sleep: true };
    if ((undead || construct) && typeImmune[what]) return true;
    if (custom.includes(what)) return true;
    return false;
}

/** Rounds in a duration (combat counts rounds; 10 rounds to the minute, CRB 239). */
export function roundsIn(count, unit) {
    const n = Number(count) || 0;
    return { round: n, minute: n * 10, hour: n * 600, day: n * 14400 }[unit] ?? 0;
}

/**
 * When an effect ends (CRB: a duration in rounds ends just before the turn of whoever created
 * it, in its last round). Returns { round, turn }: the effect is gone once the combat
 * reaches that round and turn.
 */
export function endPoint({ round, turn, rounds }) {
    return { round: round + rounds, turn };
}

/** Has the combat reached an end point? */
export function isDue(end, { round, turn }) {
    if (!end) return false;
    if (round > end.round) return true;
    return round === end.round && turn >= end.turn;
}

/** Short duration text for cards: "3 rounds", "2 minutes", "until removed". */
export function durationLabel(count, unit) {
    if (!unit || count == null) return "until removed";
    return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** Burning's extinguish save (CRB 273): DC 10 + the fire damage burning dealt this round. */
export const burnSaveDC = (damage) => 10 + (Number(damage) || 0);
