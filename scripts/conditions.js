/**
 * Layer 3 on Foundry: conditions from failed saves and critical hits, applied with sfrpg's own
 * setCondition and removed by the module when their time is up.
 *
 * sfrpg 14 keeps each condition as an effect item from the sfrpg.conditions pack. Its own timed
 * effects run on world time and only disable an item, so the module keeps its own clock: a flag
 * on the condition item says when it ends (combat round and turn, or world time out of combat),
 * and the active GM's client removes it then. Conditions set by hand are never touched.
 *
 * Ongoing damage (burning, bleeding, corrode) is a list on the actor's flags: the GM's client
 * deals it at the start of the creature's turn; burning and corrode get a Reflex save at the end
 * of its turn; bleeding stops once the creature has been healed.
 */
import { MODULE_ID, KIND, ATTACK_OPTIONS } from "./constants.js";
import { getSetting } from "./settings.js";
import { rollSaveFor } from "./saves.js";
import { saveSucceeds, SAVE_LABEL } from "./logic.js";
import { tokenDistance } from "./rules.js";
import {
    effectsFromItem, spellDurationField, parseCrit, critSaveDC, immuneTo, roundsIn, isDue,
    durationLabel, burnSaveDC
} from "./effects.js";

const TRACK = "l3";
const cap = (s) => String(s ?? "").replace(/(^|[\s-])\w/g, c => c.toUpperCase());

/* ---------- reading the item (on the roller's client) ---------- */

/** Fill @-paths from roll data; a formula with no dice comes back as a number. */
function resolveFormula(formula, rollData) {
    let f = String(formula ?? "").trim();
    if (!f) return null;
    try {
        f = Roll.replaceFormulaData(f, rollData ?? {}, { missing: "0" });
        if (!/d/i.test(f)) return String(Math.max(0, Math.floor(Roll.safeEval(f))));
    } catch (err) {
        return null;
    }
    return f.replace(/\s/g, "");
}

/** The conditions an item inflicts on a failed save, with durations worked out for its user. */
export function itemEffectsData(item) {
    const s = item?.system ?? {};
    const rollData = item.actor?.getRollData?.() ?? {};
    const field = spellDurationField(s.duration);
    const spellDuration = field ? { formula: resolveFormula(field.formula, rollData), unit: field.unit } : null;
    const e = effectsFromItem({ chatFlavor: s.chatFlavor ?? "", description: s.description?.value ?? "", spellDuration: spellDuration?.formula ? spellDuration : null });
    for (const x of e.list) {
        if (x.dur) x.dur = { ...x.dur, formula: resolveFormula(x.dur.formula, rollData) };
        if (x.dur && !x.dur.formula) x.dur = null;
    }
    return e.list.length ? e : null;
}

/** An item's critical hit effects and their DC (CRB 181). */
export function itemCritData(item) {
    const effects = parseCrit(item?.system?.critical?.effect);
    if (!effects.length) return null;
    const s = item.system ?? {};
    const melee = ["mwak", "msak"].includes(s.actionType) || s.weaponType === "basicM" || s.weaponType === "advancedM";
    const thrown = !!s.properties?.thrown?.value || s.properties?.thrown === true;
    const ability = melee || thrown ? "str" : "dex";
    const mod = item.actor?.system?.abilities?.[ability]?.mod ?? 0;
    const level = Number(s.level) || 1;
    const dexMod = item.actor?.system?.abilities?.dex?.mod ?? 0;
    return { effects, level, ability, dexMod, dc: critSaveDC(level, mod) };
}

/* ---------- the module's clock ---------- */

const activeCombat = () => (game.combat?.started ? game.combat : null);

/** When an effect of `rounds` rounds, applied now, ends. */
function expiryFor(rounds) {
    if (rounds == null) return null;
    const combat = activeCombat();
    if (combat) {
        return { combatId: combat.id, originId: combat.combatant?.id ?? null, end: { round: combat.round + rounds, turn: combat.turn ?? 0 } };
    }
    return { worldEnd: game.time.worldTime + rounds * (CONFIG.time?.roundTime ?? 6) };
}

const later = (a, b) => {
    if (!a || !b) return null;
    if (a.worldEnd != null && b.worldEnd != null) return a.worldEnd >= b.worldEnd ? a : b;
    if (a.end && b.end && a.combatId === b.combatId) return (a.end.round > b.end.round || (a.end.round === b.end.round && a.end.turn >= b.end.turn)) ? a : b;
    return b;
};

async function rollCount(formula) {
    if (formula == null) return null;
    if (/^\d+$/.test(String(formula))) return Number(formula);
    const r = await new Roll(String(formula)).evaluate();
    return r.total;
}

function creatureInfo(actor) {
    const s = actor?.system ?? {};
    const ci = s.traits?.ci ?? {};
    return { type: s.details?.type ?? "", ci: Array.isArray(ci.value) ? ci.value : [], ciCustom: ci.custom ?? "" };
}

const IMMUNE_WORD = { stunned: "stun", paralyzed: "paralysis", asleep: "sleep", bleeding: "bleed" };

/**
 * Give an actor a condition for `rounds` rounds (null: until removed). Returns a record for the
 * card and for Undo: { cond, label, applied, extended, prev, immune, already }.
 */
export async function addCondition(actor, cond, { rounds = null, source = "", immune = null } = {}) {
    const rec = { cond, label: cap(cond), rounds, actorUuid: actor.uuid };
    const info = creatureInfo(actor);
    if (immuneTo(info, cond) || (IMMUNE_WORD[cond] && immuneTo(info, IMMUNE_WORD[cond])) || (immune && immuneTo(info, immune))) {
        rec.immune = true;
        return rec;
    }
    if (typeof actor.setCondition !== "function") {
        rec.note = "no conditions on this actor";
        return rec;
    }
    const had = actor.hasCondition?.(cond);
    const existing = actor.getCondition?.(cond);
    const tracked = existing?.flags?.[MODULE_ID]?.[TRACK];
    if (had && !tracked) {
        rec.already = true;
        return rec;
    }
    const expiry = expiryFor(rounds);
    if (had && tracked) {
        // Already ours from an earlier effect: keep whichever ends later.
        rec.extended = true;
        rec.prev = tracked;
        const next = tracked.expiry && expiry ? later(tracked.expiry, expiry) : null;
        await existing.update({ [`flags.${MODULE_ID}.${TRACK}`]: { ...tracked, expiry: next, source } });
        return rec;
    }
    await actor.setCondition(cond, true);
    const item = actor.getCondition?.(cond);
    if (item) await item.update({ [`flags.${MODULE_ID}.${TRACK}`]: { expiry, source } });
    rec.applied = true;
    return rec;
}

/** Undo one record from addCondition. */
export async function undoCondition(rec) {
    if (!rec || (!rec.applied && !rec.extended)) return;
    const actor = await fromUuid(rec.actorUuid);
    if (!actor) return;
    const item = actor.getCondition?.(rec.cond);
    if (!item?.flags?.[MODULE_ID]?.[TRACK]) return;
    if (rec.applied) await actor.setCondition(rec.cond, false);
    else if (rec.prev) await item.update({ [`flags.${MODULE_ID}.${TRACK}`]: rec.prev });
}

/* ---------- ongoing damage ---------- */

const ongoingOf = (actor) => foundry.utils.deepClone(actor?.flags?.[MODULE_ID]?.ongoing ?? []);

async function setOngoing(actor, list) {
    await actor.update({ [`flags.${MODULE_ID}.ongoing`]: list });
}

const avg = (formula) => {
    let total = 0;
    for (const m of String(formula).matchAll(/(\d+)d(\d+)|([+-]?\d+)/g)) {
        if (m[1]) total += Number(m[1]) * (Number(m[2]) + 1) / 2;
        else total += Number(m[3]);
    }
    return total;
};

/** Add burning, bleeding or corrode. Bleeding keeps only the worst (CRB 273); burning stacks. */
export async function addOngoing(actor, { kind, formula, type, source = "" }) {
    const rec = { kind, formula, type, label: kind === "corrode" ? "Corrode" : cap(kind), actorUuid: actor.uuid };
    if (kind === "bleeding" && immuneTo(creatureInfo(actor), "bleed")) {
        rec.immune = true;
        return rec;
    }
    const list = ongoingOf(actor);
    const id = foundry.utils.randomID();
    if (kind === "bleeding") {
        const worse = list.find(o => o.kind === "bleeding" && avg(o.formula) >= avg(formula));
        if (worse) {
            rec.note = `already bleeding ${worse.formula}`;
            return rec;
        }
        rec.replaced = list.filter(o => o.kind === "bleeding");
        for (const o of rec.replaced) list.splice(list.indexOf(o), 1);
    }
    const hp = actor.system?.attributes?.hp?.value ?? 0;
    list.push({ id, kind, formula, type, source, hpMark: hp });
    await setOngoing(actor, list);
    if (kind !== "corrode") rec.cond = await addCondition(actor, kind, { rounds: null, source });
    rec.id = id;
    rec.applied = true;
    return rec;
}

export async function undoOngoing(rec) {
    if (!rec?.applied) return;
    const actor = await fromUuid(rec.actorUuid);
    if (!actor) return;
    const list = ongoingOf(actor).filter(o => o.id !== rec.id);
    for (const o of rec.replaced ?? []) list.push(o);
    await setOngoing(actor, list);
    if (rec.cond && !list.some(o => o.kind === rec.kind)) await undoCondition(rec.cond);
}

/* ---------- applying an item's effects and a critical hit's ---------- */

/** Roll a duration once per workflow and effect (CRB 181: special effects roll once). */
async function countFor(wf, key, dur, level) {
    if (!dur) return null;
    wf.l3Rolls ??= {};
    if (wf.l3Rolls[key] == null) {
        const n = await rollCount(dur.formula);
        wf.l3Rolls[key] = n;
    }
    const n = wf.l3Rolls[key] * (dur.perLevel ? level : 1);
    return { count: n, unit: dur.unit, rounds: roundsIn(n, dur.unit), assumed: !!dur.assumed };
}

const sourceOf = (wf) => `${wf.item?.name ?? ""} (${wf.attacker?.name ?? ""})`;

/** A target failed its save: give it the item's conditions. Fills t.l3.conds. */
export async function applyItemEffects(wf, t, actor) {
    const fx = wf.item?.effects;
    if (!fx?.list?.length || !getSetting("applyConditions")) return;
    t.l3 ??= {};
    t.l3.conds ??= [];
    for (const e of fx.list) {
        if (e.cond === "burning" || e.cond === "bleeding") {
            const rec = await addOngoing(actor, { kind: e.cond, formula: e.amount ?? "1d6", type: e.cond === "burning" ? "fire" : null, source: sourceOf(wf) });
            t.l3.conds.push({ ...rec, ongoing: true });
            continue;
        }
        const d = await countFor(wf, `item:${e.cond}`, e.dur, 1);
        const rec = await addCondition(actor, e.cond, { rounds: d?.rounds ?? null, source: sourceOf(wf) });
        rec.duration = d ? durationLabel(d.count, d.unit) : "until removed";
        if (d?.assumed) rec.assumed = true;
        t.l3.conds.push(rec);
    }
    if (fx.resave) t.l3.resave = true;
}

/** Penalties on the attack roll also lower a critical effect's DC (CRB 181). */
function critPenalty(wf, t) {
    let p = 0;
    if (wf.kind === KIND.EXPLODE) for (const part of wf.save?.parts ?? []) p += part.value;
    else {
        p += t.range?.penalty ?? 0;
        for (const k of wf.options ?? []) if ((ATTACK_OPTIONS[k]?.mod ?? 0) < 0) p += ATTACK_OPTIONS[k].mod;
    }
    return p;
}

function nearestOthers(centerToken, exclude, reach) {
    const scene = centerToken?.parent;
    if (!scene) return [];
    const c = centerToken.object;
    if (!c) return [];
    const list = [];
    for (const doc of scene.tokens) {
        if (exclude.includes(doc.uuid) || !doc.actor || !doc.object) continue;
        if (doc.actor.system?.attributes?.hp?.value <= 0 && doc.actor.type !== "character") continue;
        const d = tokenDistance(c, doc.object);
        if (d <= reach) list.push({ doc, d });
    }
    list.sort((a, b) => a.d - b.d);
    return list;
}

const pseudoTarget = (doc) => ({ tokenUuid: doc.uuid, actorUuid: doc.actor?.uuid, name: doc.name, img: doc.texture?.src, notes: [] });

/** Damage a second creature (arc, jet, pulse): the same DR/ER and 0 HP path as any hit. */
async function secondaryHit(wf, doc, amount, label) {
    const { applyToTarget } = await import("./apply.js");
    const types = wf.damage?.crit?.[0]?.types ?? wf.damage?.normal?.[0]?.types ?? [];
    const operator = wf.damage?.crit?.[0]?.operator ?? "and";
    const mini = { damage: { normal: [{ total: amount, types, operator, formula: "" }] }, properties: wf.properties ?? [], nonlethal: wf.nonlethal };
    const pt = pseudoTarget(doc);
    await applyToTarget(mini, pt, "normal", 1);
    return { label, target: pt, amount, types };
}

/**
 * A critical hit landed on t: roll its critical hit effects. Saves go to the target's player like
 * any save. Fills t.l3.crit, a list of lines for the cards.
 */
export async function applyCritEffects(wf, t, actor) {
    const crit = wf.item?.crit;
    if (!crit?.effects?.length || !getSetting("critEffects")) return;
    t.l3 ??= {};
    t.l3.crit = [];
    const dc = crit.dc + critPenalty(wf, t);
    const targetDoc = await fromUuid(t.tokenUuid);
    for (const fx of crit.effects) {
        const rule = fx.rule;
        const line = { raw: fx.raw, key: fx.key };
        t.l3.crit.push(line);
        if (!rule) {
            line.note = "not automated: apply by hand";
            continue;
        }
        if (rule.kind === "note") {
            line.note = rule.text.replace("{amount}", fx.amount ?? "").replace("{dc}", dc);
            line.gmOnly = rule.text.includes("{dc}");
            continue;
        }
        if (rule.kind === "wound") {
            const rolls = [];
            for (let i = 0; i < rule.rolls; i++) rolls.push((await new Roll("1d20").evaluate()).total);
            line.note = `d20 ${rolls.join(" and ")} on the wounding table (CRB Table 7-1); save DC ${dc}${rule.rolls > 1 ? "; pick one" : ""}`;
            line.gmOnly = true;
            continue;
        }
        if (rule.kind === "ongoing") {
            const formula = fx.amount ?? "1d6";
            const rec = await addOngoing(actor, { kind: rule.cond ?? "corrode", formula, type: rule.type, source: sourceOf(wf) });
            line.ongoing = rec;
            continue;
        }
        if (rule.kind === "secondary" || rule.kind === "pulse") {
            const amount = fx.amount ? (await new Roll(fx.amount).evaluate()).total : 0;
            line.amount = amount;
            if (!amount || !targetDoc) {
                line.note = "no damage listed";
                continue;
            }
            if (rule.kind === "pulse") {
                const near = nearestOthers(targetDoc, [t.tokenUuid], 5);
                line.hits = [];
                for (const n of near) line.hits.push(await secondaryHit(wf, n.doc, amount, fx.raw));
                if (!near.length) line.note = "no one adjacent";
                continue;
            }
            // Arc: the nearest creature within 10 ft (CRB 182). Jet: the GM picks (Armory 26).
            const firstArc = rule.second ? t.l3.crit.find(l => l.key === "arc" && l.hits?.length)?.hits[0]?.target?.tokenUuid : null;
            const from = rule.second && firstArc ? await fromUuid(firstArc) : targetDoc;
            const near = nearestOthers(from, [t.tokenUuid, firstArc].filter(Boolean), rule.reach);
            const ties = rule.nearest ? near.filter(n => n.d === near[0]?.d) : near;
            if (!near.length) {
                line.note = `no one within ${rule.reach} ft`;
            } else if (rule.nearest && ties.length === 1) {
                line.hits = [await secondaryHit(wf, ties[0].doc, amount, fx.raw)];
            } else {
                line.choices = ties.map(n => ({ tokenUuid: n.doc.uuid, name: n.doc.name }));
                line.note = rule.nearest ? "equally near: pick one" : "pick the creature behind the target";
            }
            continue;
        }
        if (rule.kind === "cond") {
            line.cond = rule.cond;
            if (rule.save) {
                const res = await rollSaveFor(actor, rule.save, { itemName: `${wf.item?.publicName ?? wf.item?.name} (critical)`, casterName: wf.attacker?.name });
                if (!res) {
                    line.note = "save not rolled";
                    continue;
                }
                const saved = saveSucceeds(res.d20, res.total, dc);
                line.save = { type: rule.save, d20: res.d20, total: res.total, dc, saved, by: res.by };
                if (saved) continue;
            }
            const dur = rule.perLevel ? { formula: "1", unit: "round", perLevel: true } : rule.dur;
            const d = await countFor(wf, `crit:${fx.key}`, dur, crit.level);
            const rec = await addCondition(actor, rule.cond, { rounds: d?.rounds ?? null, source: `${sourceOf(wf)} critical`, immune: rule.immune });
            rec.duration = d ? durationLabel(d.count, d.unit) : (rule.escape ? "until it escapes" : "until removed");
            if (rule.escape) {
                const dex = crit.dexMod ?? 0;
                line.note = `escape: Acrobatics DC ${10 + crit.level + dex} or Strength DC ${15 + crit.level + dex}, a move action`;
                line.gmOnly = true;
            }
            line.rec = rec;
        }
    }
}

/** A GM pick for arc ties and jet: damage that creature. */
export async function pickSecondary(wf, t, lineIndex, tokenUuid) {
    const line = t.l3?.crit?.[lineIndex];
    if (!line?.choices) return;
    const doc = await fromUuid(tokenUuid);
    if (!doc) return;
    line.hits = [await secondaryHit(wf, doc, line.amount, line.raw)];
    line.choices = null;
    line.note = null;
}

/** Take back everything layer 3 did to one target (Undo, flips, misses). */
export async function undoEffects(t) {
    const l3 = t.l3;
    if (!l3) return;
    const { undoTarget } = await import("./apply.js");
    for (const rec of [...(l3.conds ?? [])].reverse()) {
        if (rec.ongoing) await undoOngoing(rec);
        else await undoCondition(rec);
    }
    for (const line of [...(l3.crit ?? [])].reverse()) {
        if (line.rec) await undoCondition(line.rec);
        if (line.ongoing) await undoOngoing(line.ongoing);
        for (const h of line.hits ?? []) await undoTarget(h.target);
    }
    t.l3 = null;
}

/** Remove a target's conditions from this effect now (the GM card's button), keeping damage. */
export async function removeEffects(t) {
    const l3 = t.l3;
    if (!l3) return;
    for (const rec of l3.conds ?? []) {
        if (rec.ongoing) await undoOngoing(rec);
        else await undoCondition(rec);
        rec.removed = true;
        rec.applied = false;
        rec.extended = false;
    }
    for (const line of l3.crit ?? []) {
        if (line.rec) {
            await undoCondition(line.rec);
            line.rec.removed = true;
            line.rec.applied = false;
        }
        if (line.ongoing) {
            await undoOngoing(line.ongoing);
            line.ongoing.removed = true;
            line.ongoing.applied = false;
        }
    }
}

/* ---------- the clock: expiry, ongoing damage, burning saves ---------- */

const isActiveGM = () => game.user?.isGM && (game.users.activeGM?.id ?? game.user.id) === game.user.id;

function actorsIn(combat) {
    const set = new Map();
    for (const c of combat?.combatants ?? []) if (c.actor) set.set(c.actor.uuid, c.actor);
    for (const tok of canvas?.scene?.tokens ?? []) if (tok.actor) set.set(tok.actor.uuid, tok.actor);
    return [...set.values()];
}

function trackedConditions(actor) {
    return actor.items.filter(i => i.type === "effect" && i.flags?.[MODULE_ID]?.[TRACK]);
}

async function expire(actor, item, why) {
    const cond = item.name.toLowerCase();
    if (CONFIG.SFRPG?.conditionTypes?.[cond] && actor.hasCondition?.(cond)) await actor.setCondition(cond, false);
    else await item.delete();
    return `${cap(cond)} ended on ${actor.name}${why ? ` (${why})` : ""}`;
}

/** Remove what's due in a combat at its current round and turn. */
async function expireInCombat(combat) {
    const notes = [];
    for (const actor of actorsIn(combat)) {
        for (const item of trackedConditions(actor)) {
            const x = item.flags[MODULE_ID][TRACK]?.expiry;
            if (!x?.end || x.combatId !== combat.id) continue;
            let turn = x.end.turn;
            if (x.originId) {
                const idx = combat.turns.findIndex(c => c.id === x.originId);
                if (idx >= 0) turn = idx;
            }
            if (isDue({ round: x.end.round, turn }, { round: combat.round, turn: combat.turn ?? 0 })) notes.push(await expire(actor, item));
        }
    }
    return notes;
}

/** Out of combat (or a combat that ended): world time. */
async function expireByTime() {
    if (!isActiveGM()) return;
    const now = game.time.worldTime;
    const notes = [];
    for (const actor of actorsIn(null)) {
        for (const item of trackedConditions(actor)) {
            const x = item.flags[MODULE_ID][TRACK]?.expiry;
            if (x?.worldEnd != null && now >= x.worldEnd) notes.push(await expire(actor, item));
        }
    }
    if (notes.length) await gmNote(notes);
}

async function gmNote(lines, { publicLines = null, speaker = null } = {}) {
    const gmIds = ChatMessage.getWhisperRecipients("GM").map(u => u.id);
    if (publicLines?.length) {
        await ChatMessage.create({ speaker: speaker ?? { alias: "Combat" }, content: `<div class="sca-card sca-l3-tick">${publicLines.map(l => `<div class="sca-line">${foundry.utils.escapeHTML(l)}</div>`).join("")}</div>`, flags: { [MODULE_ID]: { public: true } } });
    }
    if (lines?.length) {
        await ChatMessage.create({ speaker: speaker ?? { alias: "Combat automation" }, whisper: gmIds, content: `<div class="sca-card sca-l3-tick">${lines.map(l => `<div class="sca-line sca-notes">${foundry.utils.escapeHTML(l)}</div>`).join("")}</div>`, flags: { [MODULE_ID]: { l3note: true } } });
    }
}

/** Start of a creature's turn: bleeding stops if it was healed; then each ongoing effect deals damage. */
async function tickOngoing(combatant) {
    const actor = combatant?.actor;
    const token = combatant?.token;
    const list = ongoingOf(actor);
    if (!actor || !token || !list.length) return;
    const { applyToTarget } = await import("./apply.js");
    const pub = [];
    const gm = [];
    const hp = actor.system?.attributes?.hp?.value ?? 0;
    let changed = false;
    for (const o of [...list]) {
        if (o.kind === "bleeding" && hp > (o.hpMark ?? hp)) {
            list.splice(list.indexOf(o), 1);
            changed = true;
            if (actor.hasCondition?.("bleeding") && !list.some(x => x.kind === "bleeding")) await actor.setCondition("bleeding", false);
            pub.push(`${token.name} stops bleeding (healed).`);
            continue;
        }
        const roll = await new Roll(o.formula).evaluate();
        const mini = { damage: { normal: [{ total: roll.total, types: o.type ? [o.type] : [], operator: "and", formula: o.formula }] }, properties: [] };
        const pt = pseudoTarget(token);
        await applyToTarget(mini, pt, "normal", 1);
        const dealt = pt.applied?.dealt ?? 0;
        o.lastDamage = dealt;
        o.lastRoll = roll.total;
        o.hpMark = actor.system?.attributes?.hp?.value ?? 0;
        changed = true;
        const what = o.kind === "corrode" ? "Corrode" : cap(o.kind);
        pub.push(`${what}: ${token.name} takes ${dealt} ${o.type ?? ""} damage.`.replace("  ", " "));
        gm.push(`${what} ${o.formula} on ${token.name}: rolled ${roll.total}; ${pt.applied?.math?.join("; ") ?? ""}${pt.applied?.status ? ` · ${pt.applied.status}` : ""}`);
    }
    if (changed) await setOngoing(actor, list);
    if (pub.length) await gmNote(gm, { publicLines: pub, speaker: ChatMessage.getSpeaker({ token }) });
}

/** End of a burning creature's turn: a Reflex save puts it out (CRB 273); corrode works the same. */
async function burnSaves(combatant) {
    const actor = combatant?.actor;
    const token = combatant?.token;
    const list = ongoingOf(actor);
    const burns = list.filter(o => o.kind === "burning" || o.kind === "corrode");
    if (!actor || !burns.length) return;
    const pub = [];
    const gm = [];
    for (const o of burns) {
        const dc = burnSaveDC(o.lastDamage ?? 0);
        const res = await rollSaveFor(actor, "reflex", { itemName: o.kind === "corrode" ? "Corrode (end it)" : "Burning (put it out)" });
        if (!res) continue;
        const saved = saveSucceeds(res.d20, res.total, dc);
        gm.push(`${cap(o.kind)} on ${token?.name}: Reflex ${res.total} vs DC ${dc} (10 + ${o.lastDamage ?? 0} damage this round): ${saved ? "out" : "still going"}`);
        if (saved) {
            list.splice(list.indexOf(o), 1);
            pub.push(o.kind === "corrode" ? `The acid on ${token?.name} stops eating.` : `${token?.name} puts out the flames.`);
        }
    }
    await setOngoing(actor, list);
    if (!list.some(o => o.kind === "burning") && actor.hasCondition?.("burning")) {
        const item = actor.getCondition?.("burning");
        if (item?.flags?.[MODULE_ID]?.[TRACK]) await actor.setCondition("burning", false);
    }
    if (gm.length) await gmNote(gm, { publicLines: pub, speaker: token ? ChatMessage.getSpeaker({ token }) : null });
}

/** Hook: updateCombat. On the active GM's client only. */
export async function onCombatTurn(combat, changed) {
    if (!isActiveGM() || !combat?.started) return;
    if (!("turn" in changed || "round" in changed)) return;
    if (getSetting("applyConditions") || getSetting("critEffects")) {
        const notes = await expireInCombat(combat);
        if (notes.length) await gmNote(notes);
    }
    if (!getSetting("ongoingDamage")) return;
    const prevId = combat.previous?.combatantId;
    const prev = prevId ? combat.combatants.get(prevId) : null;
    if (prev && prev.id !== combat.combatant?.id) await burnSaves(prev);
    await tickOngoing(combat.combatant);
}

/** Hook: deleteCombat. Round counts left over carry on in world time. */
export async function onCombatEnd(combat) {
    if (!isActiveGM()) return;
    const step = CONFIG.time?.roundTime ?? 6;
    for (const actor of actorsIn(combat)) {
        for (const item of trackedConditions(actor)) {
            const data = item.flags[MODULE_ID][TRACK];
            const x = data?.expiry;
            if (!x?.end || x.combatId !== combat.id) continue;
            const left = Math.max(0, x.end.round - (combat.round ?? 0));
            await item.update({ [`flags.${MODULE_ID}.${TRACK}`]: { ...data, expiry: { worldEnd: game.time.worldTime + left * step } } });
        }
    }
}

/** Hook: updateWorldTime. */
export function onWorldTime() {
    expireByTime().catch(err => console.error(`${MODULE_ID} |`, err));
}

/** For the cards: one target's layer 3 lines. gm: include saves, DCs and buttons. */
export function effectSummary(t) {
    const l3 = t.l3;
    if (!l3) return null;
    const conds = [];
    for (const r of l3.conds ?? []) {
        if (r.removed) conds.push({ text: `${r.label}: removed`, gm: true });
        else if (r.immune) conds.push({ text: `${r.label}: immune` });
        else if (r.already) conds.push({ text: `${r.label}: already had it` });
        else if (r.ongoing) conds.push({ text: r.note ? `${r.label}: ${r.note}` : `${r.label} ${r.formula ?? ""}`.trim() });
        else conds.push({ text: `${r.label}${r.extended ? " (extended)" : ""}, ${r.duration ?? "until removed"}`, assumed: r.assumed });
    }
    const crits = [];
    for (const line of l3.crit ?? []) {
        const label = cap(line.raw);
        if (line.save) {
            const s = line.save;
            const res = s.saved ? "saved" : `failed${line.rec ? `: ${line.rec.immune ? "immune" : line.rec.already ? "already had it" : `${line.rec.label}, ${line.rec.duration}`}` : ""}`;
            crits.push({ text: `${label}: ${res}`, gmText: `${label}: ${SAVE_LABEL[s.type] ?? s.type} ${s.total} vs DC ${s.dc}, ${res}` });
        } else if (line.rec) {
            const r = line.rec;
            crits.push({ text: `${label}: ${r.removed ? "removed" : r.immune ? "immune" : r.already ? "already had it" : `${r.label}, ${r.duration}`}` });
        } else if (line.ongoing) {
            const o = line.ongoing;
            crits.push({ text: o.immune ? `${label}: immune` : o.note ? `${label}: ${o.note}` : `${label}: ${o.label} ${o.formula}${o.removed ? " (removed)" : ""}` });
        } else if (line.hits?.length) {
            crits.push({ text: `${label}: ${line.hits.map(h => `${h.target.name} takes ${h.target.applied?.dealt ?? 0}`).join(", ")}`, gmText: `${label} (${line.amount}): ${line.hits.map(h => `${h.target.name}: ${h.target.applied?.math?.join("; ") ?? "no damage"}${h.target.applied?.status ? ` · ${h.target.applied.status}` : ""}`).join(" | ")}` });
        } else {
            crits.push({ text: `${label}${line.note && !line.gmOnly ? `: ${line.note}` : ""}`, gmText: `${label}${line.note ? `: ${line.note}` : ""}`, choices: line.choices });
        }
    }
    return { conds, crits, resave: !!l3.resave };
}
