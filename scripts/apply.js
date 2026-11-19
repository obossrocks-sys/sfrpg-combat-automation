/**
 * The GM's side: applies damage with sfrpg's own math, then nonlethal and 0 HP,
 * and keeps what it changed so the card can undo or flip it.
 */
import { MODULE_ID, RESULT, KINETIC } from "./constants.js";
import { getSetting } from "./settings.js";
import { createCards, updateCards } from "./cards.js";
import { rollDamageSections } from "./workflow.js";

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
function chooseTypes(actor, section, properties) {
    if (section.operator !== "or" || section.types.length < 2) return section.types;
    const Dmg = SFRPGDamage();
    let best = section.types[0];
    let bestAmount = -Infinity;
    for (const type of section.types) {
        const d = Dmg.createDamage(section.total, [type], false, properties);
        const amount = explain(actor, d).sum;
        if (amount > bestAmount) { best = type; bestAmount = amount; }
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

function combatantsFor(tokenDoc) {
    const out = [];
    for (const combat of game.combats ?? []) {
        for (const c of combat.combatants) if (c.tokenId === tokenDoc?.id && c.sceneId === tokenDoc?.parent?.id) out.push(c);
    }
    return out;
}

async function setDefeated(actor, tokenDoc, on) {
    for (const c of combatantsFor(tokenDoc)) await c.update({ defeated: on });
    const id = CONFIG.specialStatusEffects.DEFEATED;
    await actor.toggleStatusEffect(id, { overlay: true, active: on });
}

/** 0 HP: returns what was added, for undo. */
async function zeroHp(actor, tokenDoc, nonlethal) {
    const added = { conditions: [], defeated: false, label: "" };
    const add = async (name) => {
        if (actor.hasCondition(name)) return;
        await actor.setCondition(name, true);
        added.conditions.push(name);
    };
    if (NPC_TYPES.includes(actor.type)) {
        if (nonlethal) {
            await add("unconscious");
            added.label = "Unconscious";
        } else {
            const already = combatantsFor(tokenDoc).some(c => c.defeated) || actor.statuses?.has?.(CONFIG.specialStatusEffects.DEFEATED);
            if (!already) {
                await setDefeated(actor, tokenDoc, true);
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

/** Apply one target's damage. Fills t.applied. */
export async function applyToTarget(wf, t, key) {
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
    for (const sec of sections) {
        const types = chooseTypes(actor, sec, wf.properties);
        const dmg = Dmg.createDamage(sec.total, types, key === "crit", wf.properties ?? []);
        const e = explain(actor, dmg);
        math.push(`${sec.total}${key === "crit" ? " (crit)" : ""} ${types.join(" & ") || "untyped"}: ${e.lines.join("; ")}`);
        await actor.applyDamage(dmg);
    }
    const after = pools(actor);
    const applied = {
        key,
        lostTemp: before.temp - after.temp,
        tempmaxBefore: before.tempmax,
        lostSp: before.sp - after.sp,
        lostHp: before.hp - after.hp,
        before, after, math,
        conditions: [], defeated: false, status: ""
    };
    applied.dealt = applied.lostTemp + applied.lostSp + applied.lostHp;

    if (getSetting("zeroHpConditions") && after.hp <= 0 && before.hp > 0) {
        const z = await zeroHp(actor, tokenDoc, wf.nonlethal);
        applied.conditions = z.conditions;
        applied.defeated = z.defeated;
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
        if (ap.defeated) await setDefeated(actor, tokenDoc, false);
    }
    t.applied = null;
}

/** Entry point on the GM's client (socketlib target). */
export async function processAttack(wf) {
    const auto = getSetting("autoApply");
    for (const t of wf.targets) {
        t.applied = null;
        t.flipped = false;
        if (auto && (t.result === RESULT.HIT || t.result === RESULT.CRIT)) {
            await applyToTarget(wf, t, t.result === RESULT.CRIT ? "crit" : "normal");
        }
    }
    wf.undone = false;
    await createCards(wf);
    return true;
}

/** Buttons on the GM card. */
export async function gmAction(message, action, index) {
    if (!game.user.isGM) return;
    const wf = foundry.utils.deepClone(message.getFlag(MODULE_ID, "workflow"));
    if (!wf) return;
    const t = index != null ? wf.targets[index] : null;

    if (action === "undo") {
        for (const tt of wf.targets) await undoTarget(tt);
        wf.undone = true;
    } else if (action === "redo") {
        for (const tt of wf.targets) {
            if (!tt.applied && (tt.result === RESULT.HIT || tt.result === RESULT.CRIT)) {
                await applyToTarget(wf, tt, tt.result === RESULT.CRIT ? "crit" : "normal");
            }
        }
        wf.undone = false;
    } else if (action === "flip" && t) {
        if (t.result === RESULT.HIT || t.result === RESULT.CRIT) {
            await undoTarget(t);
            t.result = RESULT.MISS;
        } else {
            t.result = RESULT.HIT;
            if (!wf.damage.normal?.length && wf.item.hasDamage) {
                const item = await fromUuid(wf.item.uuid);
                if (item) wf.damage.normal = await rollDamageSections(item, false);
            }
            if (!wf.undone) await applyToTarget(wf, t, "normal");
        }
        t.flipped = !t.flipped;
    } else if (action === "apply" && t) {
        if (!t.applied && (t.result === RESULT.HIT || t.result === RESULT.CRIT)) {
            await applyToTarget(wf, t, t.result === RESULT.CRIT ? "crit" : "normal");
        }
    }
    await updateCards(message, wf);
}
