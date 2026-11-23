/**
 * The GM's side: applies damage with sfrpg's own math, then nonlethal and 0 HP,
 * and keeps what it changed so the card can undo or flip it.
 * Layer 2 adds saves (each target's share of the damage), the line rule and rider saves.
 */
import { MODULE_ID, RESULT, KINETIC, KIND, COVER } from "./constants.js";
import { getSetting } from "./settings.js";
import { createCards, updateCards } from "./cards.js";
import { rollDamageSections } from "./workflow.js";
import { saveSucceeds, damageFactor, scaled } from "./logic.js";
import { rollSaveFor, evasionOf, spellResistanceOf, rollSpellResistance, immuneToMind } from "./saves.js";

const PC_TYPES = ["character"];
const NPC_TYPES = ["npc", "npc2"];

function SFRPGDamage() {
    return game.sfrpg?.Actor?.Damage?.SFRPGDamage;
}

function pools(actor) {
    const a = actor.system.attributes;
    return {
        temp: parseInt(a.hp.temp) || 0,
        tempmax: parseInt(a.hp.tempmax) || 0,
        sp: a.sp?.value || 0,
        spMax: a.sp?.max || 0,
        hp: a.hp.value || 0,
        hpMax: a.hp.max || 0
    };
}

async function targetActor(t) {
    const doc = await fromUuid(t.tokenUuid);
    return { tokenDoc: doc, actor: doc?.actor ?? (t.actorUuid ? await fromUuid(t.actorUuid) : null) };
}

/** For "A or F" damage, use the type that hurts this target most. */
function chooseTypes(actor, section, properties, amount) {
    if (section.operator !== "or" || section.types.length < 2) return section.types;
    const Dmg = SFRPGDamage();
    let best = section.types[0];
    let bestAmount = -Infinity;
    for (const type of section.types) {
        const d = Dmg.createDamage(amount, [type], false, properties);
        const dealt = explain(actor, d).sum;
        if (dealt > bestAmount) { best = type; bestAmount = dealt; }
    }
    return [best];
}

/** The same steps as sfrpg's _applyActorDamage, written out for the GM card. */
function explain(actor, dmg) {
    const lines = [];
    let sum = 0;
    if (!dmg.damageTypes.length) {
        lines.push(`${dmg.amount} untyped`);
        return { lines, sum: dmg.amount };
    }
    const share = dmg.amount / dmg.damageTypes.length;
    for (const type of dmg.damageTypes) {
        if (actor.isImmuneToDamageType(type)) {
            lines.push(`${type}: immune`);
            continue;
        }
        let x = share;
        let s = `${fmt(share)} ${type}`;
        if (actor.isVulnerableToDamageType(type)) {
            x *= 1.5;
            s += " x1.5 (vulnerable)";
        }
        const m = actor.getDamageMitigationForDamageType(type, dmg);
        if (m) {
            x -= m;
            s += ` -${m} ${KINETIC.includes(type) ? "DR" : "ER"}`;
        }
        x = Math.max(0, x);
        s += ` = ${fmt(x)}`;
        lines.push(s);
        sum += x;
    }
    return { lines, sum };
}

const fmt = (n) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
const SHARE = { 1: "", 0.5: "half", 0: "none" };

function combatantsFor(tokenDoc) {
    const out = [];
    for (const combat of game.combats ?? []) {
        for (const c of combat.combatants) if (c.tokenId === tokenDoc?.id && c.sceneId === tokenDoc?.parent?.id) out.push(c);
    }
    return out;
}

/**
 * Mark a creature dead (large dead icon) or lift it. With "Remove the dead from the combat
 * tracker" on, killing deletes its combatants and returns them so Undo can put them back.
 */
async function setDefeated(actor, tokenDoc, on, removed = null) {
    const id = CONFIG.specialStatusEffects.DEFEATED;
    let out = null;
    if (on && getSetting("removeDead")) {
        out = [];
        for (const c of combatantsFor(tokenDoc)) {
            out.push({ combatId: c.parent.id, data: c.toObject() });
            await c.delete();
        }
    } else {
        for (const c of combatantsFor(tokenDoc)) await c.update({ defeated: on });
    }
    if (!on && removed?.length) {
        for (const r of removed) {
            const combat = game.combats.get(r.combatId);
            if (combat && !combat.combatants.has(r.data._id)) {
                await combat.createEmbeddedDocuments("Combatant", [{ ...r.data, defeated: false }], { keepId: true });
            }
        }
    }
    await actor.toggleStatusEffect(id, { overlay: true, active: on });
    return out;
}

/**
 * Anyone given the Dead status by hand (token HUD, the tracker's defeated toggle, a macro):
 * show the large dead icon and, with "Remove the dead" on, delete their combatants.
 * Runs on the active GM only. Unconscious and dying never trigger it.
 */
export async function onDeadStatus(effect) {
    if (game.user !== game.users.activeGM) return;
    const id = CONFIG.specialStatusEffects.DEFEATED;
    if (!effect.statuses?.has?.(id)) return;
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return;
    if (!foundry.utils.getProperty(effect, "flags.core.overlay")) await effect.update({ "flags.core.overlay": true });
    if (!getSetting("removeDead")) return;
    for (const combat of game.combats ?? []) {
        const ids = combat.combatants.filter(c => actor.isToken
            ? c.tokenId === actor.token?.id
            : (c.actorId === actor.id && c.token?.actorLink)).map(c => c.id);
        if (ids.length) await combat.deleteEmbeddedDocuments("Combatant", ids);
    }
}

function isDefeated(actor, tokenDoc) {
    return combatantsFor(tokenDoc).some(c => c.defeated) || !!actor.statuses?.has?.(CONFIG.specialStatusEffects.DEFEATED);
}

/**
 * 0 HP: returns what was added, for undo.
 * Drones (CRB 74): inactive at 0 HP; destroyed by a single attack of at least their maximum HP
 * while at 0.
 */
async function zeroHp(actor, tokenDoc, nonlethal, { before, incoming }) {
    const added = { conditions: [], defeated: false, label: "" };
    const add = async (name) => {
        if (actor.hasCondition(name)) return;
        await actor.setCondition(name, true);
        added.conditions.push(name);
    };
    if (actor.type === "drone") {
        if (before.hp > 0) {
            await add("unconscious");
            added.label = "Inactive";
        } else if (incoming >= before.hpMax) {
            if (!isDefeated(actor, tokenDoc)) {
                added.removed = await setDefeated(actor, tokenDoc, true);
                added.defeated = true;
            }
            added.label = "Destroyed";
        }
        return added;
    }
    if (NPC_TYPES.includes(actor.type)) {
        if (nonlethal) {
            await add("unconscious");
            added.label = "Unconscious";
        } else {
            if (!isDefeated(actor, tokenDoc)) {
                added.removed = await setDefeated(actor, tokenDoc, true);
                added.defeated = true;
            }
            added.label = "Dead";
        }
    } else if (PC_TYPES.includes(actor.type)) {
        if (nonlethal) {
            await add("unconscious");
            await add("stable");
            added.label = "Unconscious";
        } else {
            await add("dying");
            await add("unconscious");
            added.label = "Dying";
        }
    } else {
        added.label = "0 HP";
    }
    return added;
}

/**
 * Apply one target's damage. factor is the target's share (1, 0.5 after a save, 0).
 * Halves round down and come before DR, ER and vulnerability (sfrpg's math runs on the halved amount).
 * Fills t.applied.
 */
export async function applyToTarget(wf, t, key, factor = 1) {
    const sections = wf.damage?.[key] ?? [];
    if (!sections.length) {
        t.note = "no damage rolled";
        return;
    }
    const { tokenDoc, actor } = await targetActor(t);
    if (!actor) {
        t.note = "target is gone";
        return;
    }
    const Dmg = SFRPGDamage();
    const before = pools(actor);
    const math = [];
    let incoming = 0;
    for (const sec of sections) {
        const amount = scaled(sec.total, factor);
        const shareNote = factor === 1 ? "" : ` → ${SHARE[factor] ?? `x${factor}`} ${amount}`;
        if (amount <= 0) {
            math.push(`${sec.total}${key === "crit" ? " (crit)" : ""}${shareNote}`);
            continue;
        }
        const types = chooseTypes(actor, sec, wf.properties, amount);
        const dmg = Dmg.createDamage(amount, types, key === "crit", wf.properties ?? []);
        const e = explain(actor, dmg);
        incoming += e.sum;
        math.push(`${sec.total}${key === "crit" ? " (crit)" : ""}${shareNote} ${types.join(" & ") || "untyped"}: ${e.lines.join("; ")}`);
        await actor.applyDamage(dmg);
    }
    const after = pools(actor);
    const applied = {
        key, factor,
        lostTemp: before.temp - after.temp,
        tempmaxBefore: before.tempmax,
        lostSp: before.sp - after.sp,
        lostHp: before.hp - after.hp,
        before, after, math, incoming,
        conditions: [], defeated: false, status: ""
    };
    applied.dealt = applied.lostTemp + applied.lostSp + applied.lostHp;

    const drop = after.hp <= 0 && before.hp > 0;
    const droneWreck = actor.type === "drone" && before.hp <= 0 && incoming >= before.hpMax;
    if (getSetting("zeroHpConditions") && (drop || droneWreck)) {
        const z = await zeroHp(actor, tokenDoc, wf.nonlethal, { before, incoming });
        applied.conditions = z.conditions;
        applied.defeated = z.defeated;
        applied.removed = z.removed ?? null;
        applied.status = z.label;
    }
    t.applied = applied;
}

/** Reverse one target's applied damage by the amounts it took (safe if later attacks landed). */
export async function undoTarget(t) {
    const ap = t.applied;
    if (!ap) return;
    const { tokenDoc, actor } = await targetActor(t);
    if (actor) {
        const now = pools(actor);
        const update = {};
        if (ap.lostHp) update["system.attributes.hp.value"] = Math.min(now.hpMax, now.hp + ap.lostHp);
        if (ap.lostSp) update["system.attributes.sp.value"] = Math.min(now.spMax, now.sp + ap.lostSp);
        if (ap.lostTemp) {
            update["system.attributes.hp.temp"] = now.temp + ap.lostTemp;
            update["system.attributes.hp.tempmax"] = Math.max(now.tempmax, ap.tempmaxBefore);
        }
        if (Object.keys(update).length) await actor.update(update);
        for (const name of [...ap.conditions].reverse()) {
            if (actor.hasCondition(name)) await actor.setCondition(name, false);
        }
        if (ap.defeated) await setDefeated(actor, tokenDoc, false, ap.removed);
    }
    t.applied = null;
}

/* ---------- helpers shared by attacks and saves ---------- */

const isHit = (t) => t.result === RESULT.HIT || t.result === RESULT.CRIT || t.result === RESULT.STRUCK;
const isSaveResult = (t) => [RESULT.SAVED, RESULT.FAILED, RESULT.RESISTED, RESULT.PENDING, RESULT.BLOCKED].includes(t.result);
const keyOf = (t) => (t.result === RESULT.CRIT || t.critTarget ? "crit" : "normal");
const shareOf = (t) => (t.factor ?? 1);

/** Card updates for one workflow happen one at a time, in order. */
const queues = new Map();
function enqueue(id, fn) {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch(err => console.error(`${MODULE_ID} |`, err));
    queues.set(id, next);
    next.finally(() => {
        if (queues.get(id) === next) queues.delete(id);
    });
    return next;
}

/** Roll a save for one target and work out its share of the damage. Fills t.save, t.result, t.factor. */
async function resolveSave(wf, t, actor) {
    const s = wf.save;
    if (s.noEffect) {
        // No save and no damage (smoke): the card just lists who's in the area.
        t.result = RESULT.AREA;
        t.factor = 0;
        t.save = { none: true };
        return;
    }
    if (s.noSave) {
        t.result = RESULT.FAILED;
        t.factor = 1;
        t.save = { none: true };
        return;
    }
    const res = await rollSaveFor(actor, s.type, { itemName: wf.item.publicName ?? wf.item.name, casterName: wf.attacker.name });
    if (!res) {
        t.result = RESULT.MANUAL;
        t.note = "save not rolled";
        t.factor = 0;
        return;
    }
    const isReflex = s.type === "reflex";
    const coverBonus = isReflex ? (COVER[wf.cover]?.reflex ?? 0) : 0;
    const total = res.total + coverBonus;
    const saved = saveSucceeds(res.d20, total, s.dc);
    const ev = isReflex ? evasionOf(actor) : { level: null, lost: null };
    t.save = { d20: res.d20, roll: res.total, cover: coverBonus, total, dc: s.dc, by: res.by, saved, evasion: ev.level, evasionLost: ev.lost, evasionHad: ev.had ?? null };
    setOutcome(wf, t, saved);
}

/** Set a target's result and share from a save result (also used when the GM flips it). */
function setOutcome(wf, t, saved) {
    const s = wf.save;
    t.result = saved ? RESULT.SAVED : RESULT.FAILED;
    const f = damageFactor({ saved, onSave: s.onSave, evasion: t.save?.evasion ?? null, isReflex: s.type === "reflex" });
    t.factor = f.factor;
    t.evaded = f.evaded ?? null;
    t.flagged = !!(s.flagged && saved && !f.evaded);
    if (t.save) t.save.saved = saved;
}

/* ---------- layer 2: save effects ---------- */

/**
 * Entry point on the GM's client for save effects, damage-only effects and explode weapons.
 * Posts the cards at once (rows show "Rolling…"), then resolves each target as its save comes in.
 */

/** A player's attack used the GM's shared cover pick: clear it now that it has been spent. */
async function spendGmCover(wf) {
    if (!wf.coverFromGm || !game.user.isGM) return;
    if ((game.settings.get(MODULE_ID, "gmCover") || "none") !== "none") await game.settings.set(MODULE_ID, "gmCover", "none");
}

export async function processSave(wf) {
    await spendGmCover(wf);
    for (const t of wf.targets) {
        t.applied = null;
        t.flipped = false;
        t.result = RESULT.PENDING;
        t.factor = 0;
    }
    wf.undone = false;
    const gmMessage = await createCards(wf);
    runSaves(wf, gmMessage).catch(err => console.error(`${MODULE_ID} |`, err));
    return true;
}

async function runSaves(wf, gmMessage) {
    const auto = getSetting("autoApply");
    const caster = wf.attacker.actorUuid ? await fromUuid(wf.attacker.actorUuid) : null;
    const resolveOne = async (t) => {
        const { actor } = await targetActor(t);
        if (!actor) {
            t.result = RESULT.MANUAL;
            t.note = "target is gone";
            return;
        }
        if (wf.kind === KIND.DAMAGE) {
            t.result = RESULT.STRUCK;
            t.factor = 1;
        } else if (wf.cover === "total") {
            t.result = RESULT.BLOCKED;
            t.factor = 0;
            t.note = "total cover";
        } else if (wf.item.mindAffecting && immuneToMind(actor)) {
            // Undead and constructs (CRB): the GM card's Roll save button overrides.
            t.result = RESULT.BLOCKED;
            t.factor = 0;
            t.note = "immune to mind-affecting effects";
        } else {
            const sr = wf.item.allowsSR && getSetting("spellResistance") ? spellResistanceOf(actor) : 0;
            if (sr > 0) {
                t.sr = await rollSpellResistance(caster, sr);
                if (!t.sr.overcome) {
                    t.result = RESULT.RESISTED;
                    t.factor = 0;
                }
            }
            if (t.result !== RESULT.RESISTED) await resolveSave(wf, t, actor);
        }
        if (auto && t.factor > 0) await applyToTarget(wf, t, keyOf(t), t.factor);
        await enqueue(wf.workflowId, () => updateCards(gmMessage, wf));
    };
    // NPC saves resolve at once; players' prompts run side by side.
    await Promise.all(wf.targets.map(t => resolveOne(t).catch(err => {
        console.error(`${MODULE_ID} |`, err);
        t.result = RESULT.MANUAL;
        t.note = `error: ${err.message ?? err}`;
    })));
    await enqueue(wf.workflowId, () => updateCards(gmMessage, wf));
}

/* ---------- layer 1 attacks (plus area attacks and rider saves) ---------- */

/**
 * Apply damage to hit targets in order. A line stops at the first creature it hits that takes no
 * damage (CRB 181): later creatures in the line take none.
 */
async function applyHits(wf) {
    let stopped = false;
    for (const t of wf.targets) {
        t.stopped = false;
        if (!isHit(t)) continue;
        if (stopped) {
            t.stopped = true;
            continue;
        }
        if (shareOf(t) > 0) await applyToTarget(wf, t, keyOf(t), shareOf(t));
        if (wf.kind === KIND.LINE && t.applied && t.applied.dealt === 0) stopped = true;
    }
}

/** Entry point on the GM's client for attacks (socketlib target). */
export async function processAttack(wf) {
    await spendGmCover(wf);
    const auto = getSetting("autoApply");
    for (const t of wf.targets) {
        t.applied = null;
        t.flipped = false;
        t.factor = 1;
    }
    wf.undone = false;
    if (wf.rider) {
        // A save rider can wait on a player's prompt: post the cards first.
        for (const t of wf.targets) if (isHit(t)) t.riderPending = true;
        const gmMessage = await createCards(wf);
        runRider(wf, gmMessage, auto).catch(err => console.error(`${MODULE_ID} |`, err));
        return true;
    }
    if (auto) await applyHits(wf);
    await createCards(wf);
    return true;
}

/** Attacks whose item also calls for a save: roll it for each creature hit; "half" halves the damage. */
async function runRider(wf, gmMessage, auto) {
    await Promise.all(wf.targets.filter(isHit).map(async (t) => {
        const { actor } = await targetActor(t);
        if (!actor) return;
        const res = await rollSaveFor(actor, wf.rider.type, { itemName: wf.item.publicName ?? wf.item.name, casterName: wf.attacker.name });
        t.riderPending = false;
        if (!res) {
            t.note = "save not rolled";
            return;
        }
        const isReflex = wf.rider.type === "reflex";
        const total = res.total + (isReflex ? (COVER[wf.cover]?.reflex ?? 0) : 0);
        const saved = saveSucceeds(res.d20, total, wf.rider.dc);
        const ev = isReflex ? evasionOf(actor) : { level: null };
        t.save = { d20: res.d20, roll: res.total, total, dc: wf.rider.dc, by: res.by, saved, evasion: ev.level, rider: true };
        const f = damageFactor({ saved, onSave: wf.rider.onSave, evasion: ev.level, isReflex });
        t.factor = wf.rider.onSave === "half" ? f.factor : 1;
        t.evaded = wf.rider.onSave === "half" ? (f.evaded ?? null) : null;
    }));
    if (auto) await applyHits(wf);
    await enqueue(wf.workflowId, () => updateCards(gmMessage, wf));
}

/* ---------- the GM card's buttons ---------- */

export async function gmAction(message, action, index, value) {
    if (!game.user.isGM) return;
    const wf = foundry.utils.deepClone(message.flags?.[MODULE_ID]?.workflow);
    if (!wf) return;
    const t = index != null ? wf.targets[index] : null;
    const saveFlow = [KIND.SAVE, KIND.DAMAGE, KIND.EXPLODE].includes(wf.kind);

    if (action === "undo") {
        for (const tt of wf.targets) await undoTarget(tt);
        wf.undone = true;
    } else if (action === "redo") {
        if (saveFlow) {
            for (const tt of wf.targets) if (!tt.applied && shareOf(tt) > 0) await applyToTarget(wf, tt, keyOf(tt), shareOf(tt));
        } else {
            for (const tt of wf.targets) {
                if (!tt.applied && isHit(tt) && !tt.stopped && shareOf(tt) > 0) await applyToTarget(wf, tt, keyOf(tt), shareOf(tt));
            }
        }
        wf.undone = false;
    } else if (action === "flip" && t) {
        // Attacks: hit <-> miss.
        if (isHit(t)) {
            await undoTarget(t);
            t.result = RESULT.MISS;
        } else {
            t.result = RESULT.HIT;
            t.factor = t.factor ?? 1;
            if (!wf.damage.normal?.length && wf.item.hasDamage) {
                const item = await fromUuid(wf.item.uuid);
                if (item) wf.damage.normal = await rollDamageSections(item, false, { partIndex: wf.mode?.index });
            }
            if (!wf.undone) await applyToTarget(wf, t, "normal", shareOf(t));
        }
        t.flipped = !t.flipped;
    } else if (action === "flipsave" && t) {
        // Saves: saved <-> failed; resisted or blocked -> roll the save now.
        await undoTarget(t);
        if (t.result === RESULT.SAVED || t.result === RESULT.FAILED) {
            setOutcome(wf, t, t.result !== RESULT.SAVED);
        } else if (t.result === RESULT.RESISTED || t.result === RESULT.BLOCKED) {
            const { actor } = await targetActor(t);
            t.note = null;
            if (actor) await resolveSave(wf, t, actor);
        }
        t.flipped = !t.flipped;
        t.override = null;
        if (!wf.undone && shareOf(t) > 0) await applyToTarget(wf, t, keyOf(t), shareOf(t));
    } else if (action === "share" && t) {
        // Full, half or none, for flagged rows (partial saves) or any judgment call.
        const f = { full: 1, half: 0.5, none: 0 }[value];
        if (f == null) return;
        await undoTarget(t);
        t.factor = f;
        t.flagged = false;
        t.override = value;
        if (!wf.undone && f > 0) await applyToTarget(wf, t, keyOf(t), f);
    } else if (action === "apply" && t) {
        if (!t.applied && shareOf(t) > 0 && (saveFlow || isHit(t))) await applyToTarget(wf, t, keyOf(t), shareOf(t));
    }
    await updateCards(message, wf);
}

export { isHit, isSaveResult };
