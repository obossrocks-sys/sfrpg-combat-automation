/**
 * The roller's side of an attack: runs on the client of whoever rolled it.
 * attackRolled -> resolve each target -> roll damage on a hit -> send to the GM's client.
 */
import { MODULE_ID, RESULT } from "./constants.js";
import { getSetting } from "./settings.js";
import { resolveTarget, naturalD20, pickAcKey } from "./rules.js";
import { executeAsGM } from "./socket.js";
import { bar } from "./options-bar.js";

/** Damage rolls waiting to be linked to their workflow, keyed by workflow id. */
const pendingDamage = new Map();

/**
 * Attacks the module is handling, keyed by actor id, so preCreateChatMessage can strip
 * sfrpg's hit tag. sfrpg calls ChatMessage.create without awaiting it and then fires
 * attackRolled synchronously, so this is set before the message's pre-create hook runs
 * (by which time the targets may already be cleared).
 */
const stripFor = new Map();

function isHandledItem(actor, item) {
    if (!actor || !item) return false;
    if (["starshipWeapon", "vehicleAttack"].includes(item.type)) return false;
    if (["starship", "vehicle"].includes(actor.type)) return false;
    return true;
}

function currentTargets() {
    return [...game.user.targets].filter(t => t?.actor && t.document);
}

export function findAttackerToken(actor) {
    if (actor.isToken) return actor.token?.object ?? null;
    const controlled = canvas.tokens?.controlled?.find(t => t.actor?.id === actor.id);
    if (controlled) return controlled;
    return actor.getActiveTokens?.()[0] ?? null;
}

export function clearTargets() {
    try {
        if (canvas.tokens?.setTargets) return canvas.tokens.setTargets([], { mode: "replace" });
    } catch { /* fall back */ }
    try {
        if (game.user.updateTokenTargets) return game.user.updateTokenTargets([]);
    } catch { /* fall back */ }
    for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false });
}

/** Properties that can negate DR, the way sfrpg's own apply reads them. */
export function damageProperties(item) {
    const props = [];
    for (const [k, on] of Object.entries(item.system?.specialMaterials ?? {})) if (on) props.push(k);
    for (const [k, on] of Object.entries(item.system?.descriptors ?? {})) if (on) props.push(k);
    if (item.system?.magic || item.hasMagicDamage) props.push("magic");
    return props;
}

/** One damage section as plain data. */
function sectionData(roll, isCritical) {
    const die = roll.dice?.[0];
    const parts = die?.options?.damageParts ?? [];
    const types = new Set();
    let operator = "and";
    for (const p of parts) {
        for (const t of p.types ?? []) types.add(t);
        if (p.operator === "or" && (p.types?.length ?? 0) > 1) operator = "or";
    }
    return { total: roll.total, formula: roll.formula, types: [...types], operator, isCritical: !!isCritical };
}

/** Hook: sfrpg's damageRolled. Links a damage roll to its workflow. */
export function onDamageRolled({ roll, isCritical, rollMetadata }) {
    const id = rollMetadata?.scaWorkflowId;
    if (!id) return;
    const entry = pendingDamage.get(id);
    if (!entry) return;
    entry[rollMetadata.scaCrit ? "crit" : "normal"].push(sectionData(roll, isCritical));
}

/**
 * Roll an item's damage, normal or critical, and return its sections.
 * Used by the roller after an attack and by the GM when flipping a miss to a hit.
 */
export async function rollDamageSections(item, isCrit) {
    const workflowId = foundry.utils.randomID();
    pendingDamage.set(workflowId, { normal: [], crit: [] });
    try {
        await item.rollDamage(
            { event: { ctrlKey: !!isCrit, shiftKey: false, altKey: false, metaKey: false } },
            { skipUI: true, rollMetadata: { scaWorkflowId: workflowId, scaCrit: !!isCrit } }
        );
        let sections = pendingDamage.get(workflowId)[isCrit ? "crit" : "normal"];
        // Modal and double weapons roll every section with no dialog; keep the first mode.
        const p = item.system?.properties ?? {};
        if (sections.length > 1 && (p.modal?.value || p.double?.value)) sections = sections.slice(0, 1);
        return sections;
    } finally {
        pendingDamage.delete(workflowId);
    }
}

/**
 * Hook: preCreateChatMessage (roller's client). sfrpg writes "vs KAC 18: HIT" for the first
 * target onto the attack card, which shows the AC to players and calls any natural 20 a crit.
 * When the module is going to handle the attack, drop that tag.
 */
export function onPreCreateChatMessage(message, data) {
    try {
        if (!getSetting("enabled") || !getSetting("hideSystemHitTag")) return;
        const flags = data.flags?.sfrpg ?? message.flags?.sfrpg;
        if (flags?.rollType !== "attack") return;
        if (!flags.rollOptions?.actionTargetSource?.kac) return; // starship/vehicle sources differ
        const actorId = data.speaker?.actor ?? message.speaker?.actor;
        const until = stripFor.get(actorId);
        if (!until || until < Date.now()) return;
        stripFor.delete(actorId);
        const content = data.content ?? message.content;
        if (!content) return;
        const doc = new DOMParser().parseFromString(`<div>${content}</div>`, "text/html");
        const root = doc.body.firstElementChild;
        let changed = false;
        for (const span of root.querySelectorAll(".dice-footer > span")) {
            if (span.querySelector(":scope > span.success, :scope > span.fail")) {
                span.remove();
                changed = true;
            }
        }
        if (changed) message.updateSource({ content: root.innerHTML });
    } catch (err) {
        console.warn(`${MODULE_ID} | could not strip the system hit tag`, err);
    }
}

/** Hook: sfrpg's attackRolled (roller's client). */
export async function onAttackRolled({ actor, item, roll, rollMetadata }) {
    if (!getSetting("enabled")) return;
    if (rollMetadata?.scaSkip) return;
    if (!isHandledItem(actor, item)) return;

    // Capture everything synchronously: targets, cover and options can change while we await.
    const targets = currentTargets();
    if (!targets.length) return;
    stripFor.set(actor.id, Date.now() + 5000);
    const attackerToken = findAttackerToken(actor);
    const cover = bar.consumeCover();
    const optionsUsed = bar.activeOptionKeys();
    const nonlethal = !!item.system?.properties?.nonlethal?.value || optionsUsed.includes("nonlethal");
    const workflowId = foundry.utils.randomID();

    const results = targets.map(t => resolveTarget({ item, roll, attackerToken, targetToken: t, cover }));
    if (getSetting("clearTargets")) clearTargets();

    const needNormal = results.some(r => r.result === RESULT.HIT);
    const needCrit = results.some(r => r.result === RESULT.CRIT);
    const damage = { normal: [], crit: [] };
    if (item.hasDamage && getSetting("autoRollDamage")) {
        if (needNormal) damage.normal = await rollDamageSections(item, false);
        if (needCrit) damage.crit = await rollDamageSections(item, true);
    }

    const payload = {
        workflowId,
        userId: game.user.id,
        time: Date.now(),
        attacker: {
            actorUuid: actor.uuid,
            tokenUuid: attackerToken?.document?.uuid ?? null,
            sceneId: attackerToken?.document?.parent?.id ?? canvas.scene?.id ?? null,
            tokenId: attackerToken?.document?.id ?? null,
            actorId: actor.id,
            name: attackerToken?.document?.name ?? actor.name,
            img: attackerToken?.document?.texture?.src ?? actor.img
        },
        item: { uuid: item.uuid, name: item.name, img: item.img, type: item.type, hasDamage: !!item.hasDamage },
        attack: { total: roll.total, nat: naturalD20(roll), formula: roll.formula, acKey: pickAcKey(item) },
        cover,
        options: optionsUsed,
        nonlethal,
        properties: damageProperties(item),
        targets: results,
        damage
    };

    try {
        await executeAsGM("processAttack", payload);
    } catch (err) {
        console.error(`${MODULE_ID} |`, err);
        ui.notifications.warn("Combat automation: no GM is connected, so the damage wasn't applied. Apply it by hand from the damage card.");
    }
}
