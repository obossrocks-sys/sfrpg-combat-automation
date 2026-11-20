/**
 * The roller's side: runs on the client of whoever rolled.
 *
 * Attacks (sfrpg's attackRolled hook):
 *   - layer 1 attacks: resolve each target -> roll damage on a hit -> send to the GM's client.
 *   - explode weapons: aim at an intersection (AC 5), scatter on a miss, everyone in the burst saves.
 *   - blast, line and automatic mode: every creature in the cone or line, by each property's rule.
 * Save effects (sfrpg's Damage button on a spell or ability with a save, or with no attack and no
 * save): ItemSFRPG.rollDamage is wrapped so the roll's sections are collected, then the targets'
 * saves are run on the GM's client.
 */
import { MODULE_ID, RESULT, KIND, ATTACK_OPTIONS } from "./constants.js";
import { getSetting } from "./settings.js";
import { resolveTarget, naturalD20, pickAcKey, saveRangeWarning, hasFarShot } from "./rules.js";
import { executeAsGM, gmConnected } from "./socket.js";
import { bar } from "./options-bar.js";
import { SAVE_LABEL, saveEffect, rangePenaltyFor, stripDCs } from "./logic.js";
import { itemSaveDC, itemSaveType } from "./saves.js";
import { areaOf, explodeArea, freshTemplate, consumeTemplate, placeTemplate, tokensInTemplate, distanceToPoint, nearestToPoint, sortByDistance, scatter } from "./areas.js";

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
    if (!actor) return null;
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

let warnedNoGM = 0;
function warnNoGM() {
    if (Date.now() - warnedNoGM < 10000) return;
    warnedNoGM = Date.now();
    ui.notifications.warn("Combat automation: no GM is connected, so this roll is left to sfrpg. Apply the damage by hand.");
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

/* ---------- modal and double weapons ---------- */

const PART_TYPES = (p) => Object.entries(p.types ?? {}).filter(([, on]) => on).map(([k]) => k).join(" & ");
const partLabel = (p, i) => [p.name || `Mode ${i + 1}`, p.formula, PART_TYPES(p)].filter(Boolean).join(" · ");
/**
 * Modal and double weapons: which damage section to roll. A double weapon asks every attack
 * (each attack picks an end); a modal weapon asks once and keeps that mode until the bar's
 * Mode button is pressed.
 */
export async function chooseMode(item) {
    const p = item.system?.properties ?? {};
    const parts = item.system?.damage?.parts ?? [];
    const isDouble = !!p.double?.value;
    if (!(p.modal?.value || isDouble) || parts.length < 2) return null;
    const last = bar.modes.get(item.uuid);
    if (!isDouble && last != null && parts[last]) return { index: last, label: partLabel(parts[last], last) };
    const DialogV2 = foundry.applications.api.DialogV2;
    const pick = await DialogV2.wait({
        window: { title: `${item.name}: ${isDouble ? "which end?" : "which mode?"}` },
        position: { width: 340 },
        content: `<p>${isDouble ? "Double weapon: pick the end for this attack." : "Modal weapon: pick the mode. It stays until you press Mode on the attack bar."}</p>`,
        buttons: parts.map((part, i) => ({ action: String(i), label: partLabel(part, i), default: i === (last ?? 0) })),
        rejectClose: false
    });
    const index = pick == null ? (last ?? 0) : Number(pick);
    bar.modes.set(item.uuid, index);
    return { index, label: partLabel(parts[index], index) };
}

/**
 * Roll an item's damage, normal or critical, and return its sections.
 * Used by the roller after an attack and by the GM when flipping a miss to a hit.
 * partIndex: for modal and double weapons, roll only that damage section. sfrpg copies the
 * item's damage parts before its first await, so they're swapped just for that moment.
 */
export async function rollDamageSections(item, isCrit, { partIndex = null } = {}) {
    const workflowId = foundry.utils.randomID();
    pendingDamage.set(workflowId, { normal: [], crit: [] });
    try {
        const parts = item.system?.damage?.parts ?? [];
        const only = partIndex != null && parts[partIndex] ? [{ ...parts[partIndex], isPrimarySection: true }] : null;
        let rolling;
        const saved = item.system.damage.parts;
        if (only) item.system.damage.parts = only;
        try {
            rolling = item.rollDamage(
                { event: { ctrlKey: !!isCrit, shiftKey: false, altKey: false, metaKey: false } },
                { skipUI: true, rollMetadata: { scaWorkflowId: workflowId, scaCrit: !!isCrit } }
            );
        } finally {
            if (only) item.system.damage.parts = saved;
        }
        await rolling;
        return pendingDamage.get(workflowId)[isCrit ? "crit" : "normal"];
    } finally {
        pendingDamage.delete(workflowId);
    }
}

/* ---------- chat messages: sfrpg's hit tag and DCs ---------- */

function npcOnly(actorId) {
    if (!actorId) return false;
    const actor = game.actors.get(actorId);
    return actor ? !actor.hasPlayerOwner : false;
}

/** sfrpg item cards and rolls only; never someone's typed chat. */
function isSystemCard(data, message, content) {
    if (data.flags?.sfrpg ?? message.flags?.sfrpg) return true;
    if ((data.rolls ?? message.rolls)?.length) return true;
    return /class="[^"]*chat-card/.test(content ?? "");
}

function stripHitTag(root) {
    let changed = false;
    for (const span of root.querySelectorAll(".dice-footer > span")) {
        if (span.querySelector(":scope > span.success, :scope > span.fail")) {
            span.remove();
            changed = true;
        }
    }
    return changed;
}

/** Remove DCs from an NPC's item card and roll title before it's posted (players can read message data). */
function stripDCsFrom(root) {
    let changed = false;
    for (const el of root.querySelectorAll("[data-dc]")) {
        el.removeAttribute("data-dc");
        changed = true;
    }
    for (const el of root.querySelectorAll("[title], [alt], [aria-label], [data-tooltip]")) {
        for (const attr of ["title", "alt", "aria-label", "data-tooltip"]) {
            const v = el.getAttribute(attr);
            if (v && /\bDC\s*\d+/i.test(v)) {
                el.setAttribute(attr, stripDCs(v).trim());
                changed = true;
            }
        }
    }
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/\bDC\s*\d+/i.test(n.nodeValue)) {
            n.nodeValue = stripDCs(n.nodeValue);
            changed = true;
        }
    }
    return changed;
}

/**
 * Hook: preCreateChatMessage (creating client).
 *   - sfrpg writes "vs KAC 18: HIT" for the first target onto the attack card, which shows the AC
 *     to players and calls any natural 20 a crit. When the module handles the attack, drop it.
 *   - Hide save DCs on NPC item cards and roll titles (setting).
 */
export function onPreCreateChatMessage(message, data) {
    try {
        if (!getSetting("enabled")) return;
        const flags = data.flags?.sfrpg ?? message.flags?.sfrpg;
        const actorId = data.speaker?.actor ?? message.speaker?.actor;
        let content = data.content ?? message.content;
        let flavor = data.flavor ?? message.flavor;
        const update = {};

        let root = null;
        const parse = () => {
            if (root || !content) return root;
            const doc = new DOMParser().parseFromString(`<div>${content}</div>`, "text/html");
            root = doc.body.firstElementChild;
            return root;
        };

        if (getSetting("hideSystemHitTag") && flags?.rollType === "attack" && flags.rollOptions?.actionTargetSource?.kac) {
            const until = stripFor.get(actorId);
            if (until && until >= Date.now()) {
                stripFor.delete(actorId);
                if (parse() && stripHitTag(root)) update.content = root.innerHTML;
            }
        }

        if (getSetting("hideDCs") && npcOnly(actorId) && !message.flags?.[MODULE_ID] && isSystemCard(data, message, content)) {
            if (content && /\bDC\s*\d+|data-dc=/i.test(content) && parse() && stripDCsFrom(root)) update.content = root.innerHTML;
            if (flavor && /\bDC\s*\d+/i.test(flavor)) update.flavor = stripDCs(flavor);
        }

        if (Object.keys(update).length) message.updateSource(update);
    } catch (err) {
        console.warn(`${MODULE_ID} | could not clean up the chat message`, err);
    }
}

/* ---------- shared payload pieces ---------- */

function attackerData(actor, attackerToken) {
    return {
        actorUuid: actor.uuid,
        tokenUuid: attackerToken?.document?.uuid ?? null,
        sceneId: attackerToken?.document?.parent?.id ?? canvas.scene?.id ?? null,
        tokenId: attackerToken?.document?.id ?? null,
        actorId: actor.id,
        name: attackerToken?.document?.name ?? actor.name,
        img: attackerToken?.document?.texture?.src ?? actor.img
    };
}

function itemData(item) {
    const hide = getSetting("hideDCs") && !item.actor?.hasPlayerOwner;
    return {
        uuid: item.uuid, name: item.name, img: item.img, type: item.type, hasDamage: !!item.hasDamage,
        publicName: hide ? stripDCs(item.name).trim() : item.name,
        allowsSR: item.type === "spell" && !!item.system?.sr
    };
}

function targetData(token) {
    return {
        tokenUuid: token.document.uuid,
        actorUuid: token.actor?.uuid,
        name: token.document.name,
        img: token.document.texture?.src,
        notes: []
    };
}

/** Attack penalties on the roll that also lower an explode DC (CRB 181), from the bar. */
function barPenalties(optionsUsed) {
    return optionsUsed.map(k => ATTACK_OPTIONS[k]).filter(o => o && o.mod < 0).map(o => ({ label: o.short.toLowerCase(), value: o.mod }));
}

async function send(handler, payload) {
    try {
        await executeAsGM(handler, payload);
    } catch (err) {
        console.error(`${MODULE_ID} |`, err);
        ui.notifications.warn("Combat automation: no GM is connected, so the damage wasn't applied. Apply it by hand from the damage card.");
    }
}

function showDice(roll) {
    try {
        game.dice3d?.showForRoll(roll, game.user, true);
    } catch { /* optional */ }
}

/* ---------- routing ---------- */

/** Which flow an attack roll takes. */
function attackFlow(item, autoMode) {
    const p = item.system?.properties ?? {};
    const on = (k) => !!p[k]?.value;
    const saves = getSetting("automateSaves");
    const areas = getSetting("areaAttacks");
    if (on("explode") && saves) return KIND.EXPLODE;
    if (on("blast") && areas) return KIND.BLAST;
    if (on("line") && areas) return KIND.LINE;
    if (on("automatic") && autoMode && areas) return KIND.AUTOMATIC;
    // Spells and abilities stored as attacks that are really area saves (sfrpg's Explosive Blast):
    // the damage roll runs them, so the attack roll is left alone.
    if (saves && item.hasSave && item.hasDamage && areaOf(item)) return "saveArea";
    return KIND.ATTACK;
}

/** Hook: sfrpg's attackRolled (roller's client). */
export async function onAttackRolled({ actor, item, roll, rollMetadata }) {
    if (!getSetting("enabled")) return;
    if (rollMetadata?.scaSkip) return;
    if (!isHandledItem(actor, item)) return;

    // Capture everything synchronously: targets, cover and options can change while we await.
    const autoMode = bar.consumeAuto();
    const flow = attackFlow(item, autoMode);
    if (flow === "saveArea") return;
    const targets = currentTargets();
    if (flow === KIND.ATTACK && !targets.length) return;
    if (!gmConnected()) return warnNoGM();

    stripFor.set(actor.id, Date.now() + 5000);
    const ctx = {
        actor, item, roll, targets, autoMode,
        attackerToken: findAttackerToken(actor),
        cover: bar.consumeCover(),
        optionsUsed: bar.activeOptionKeys()
    };
    ctx.nonlethal = !!item.system?.properties?.nonlethal?.value || ctx.optionsUsed.includes("nonlethal");

    if (flow === KIND.EXPLODE) return explodeFlow(ctx);
    if ([KIND.BLAST, KIND.LINE, KIND.AUTOMATIC].includes(flow)) return areaAttackFlow(ctx, flow);
    return attackFlowLayer1(ctx);
}

/* ---------- layer 1: one roll against each target ---------- */

async function attackFlowLayer1(ctx) {
    const { actor, item, roll, targets, attackerToken, cover, optionsUsed, nonlethal } = ctx;
    if (!targets.length) return;
    const results = targets.map(t => resolveTarget({ item, roll, attackerToken, targetToken: t, cover }));
    if (getSetting("clearTargets")) clearTargets();

    const needNormal = results.some(r => r.result === RESULT.HIT);
    const needCrit = results.some(r => r.result === RESULT.CRIT);
    const damage = { normal: [], crit: [] };
    let mode = null;
    if (item.hasDamage && getSetting("autoRollDamage") && (needNormal || needCrit)) {
        mode = await chooseMode(item);
        if (needNormal) damage.normal = await rollDamageSections(item, false, { partIndex: mode?.index });
        if (needCrit) damage.crit = await rollDamageSections(item, true, { partIndex: mode?.index });
    }

    // A save on an attack item (a rider such as "plus inflame"): rolled for each creature hit.
    let rider = null;
    if (getSetting("automateSaves") && item.hasSave && results.some(r => r.result === RESULT.HIT || r.result === RESULT.CRIT)) {
        const type = itemSaveType(item);
        if (type) {
            const eff = saveEffect(item.system.save?.descriptor);
            if (!eff.noSave) rider = { type, label: SAVE_LABEL[type], dc: itemSaveDC(item), onSave: eff.onSave, descriptor: item.system.save?.descriptor ?? "" };
        }
    }

    await send("processAttack", {
        workflowId: foundry.utils.randomID(),
        kind: KIND.ATTACK,
        userId: game.user.id,
        time: Date.now(),
        attacker: attackerData(actor, attackerToken),
        item: itemData(item),
        attack: { total: roll.total, nat: naturalD20(roll), formula: roll.formula, acKey: pickAcKey(item) },
        cover, options: optionsUsed, nonlethal,
        properties: damageProperties(item),
        targets: results,
        damage, mode, rider
    });
}

/* ---------- explode: grenades and other explode weapons ---------- */

async function explodeFlow(ctx) {
    const { actor, item, roll, attackerToken, cover, optionsUsed, nonlethal } = ctx;
    const spec = await explodeArea(item);
    let doc = freshTemplate(item);
    const placedNow = !doc;
    if (!doc) doc = await placeTemplate(item, spec);
    if (!doc) return; // cancelled: the attack card stays as sfrpg posted it
    consumeTemplate(item);

    // Attack against AC 5 at the intersection, with range and the bar's penalties (CRB 245).
    const aim = { x: doc.x, y: doc.y };
    const increment = item.system?.range?.units === "ft" ? Number(item.system.range.value) || 0 : 0;
    const distance = attackerToken ? distanceToPoint(attackerToken, aim) : null;
    const range = increment && distance != null && getSetting("rangePenalties")
        ? rangePenaltyFor(distance, increment, { thrown: !!item.system?.properties?.thrown?.value, farShot: hasFarShot(actor) })
        : null;
    const nat = naturalD20(roll);
    const eff = roll.total + (range?.penalty ?? 0);
    let hit = nat === 20 || (nat !== 1 && eff >= 5);
    const notes = [];
    if (range?.outOfRange) {
        hit = false;
        notes.push(`beyond maximum range (${range.maxRange} ft)`);
    }
    let scattered = null;
    if (!hit) {
        scattered = await scatter(doc, attackerToken);
        doc = doc.parent?.templates?.get?.(doc.id) ?? doc;
    }

    // Who's in the burst: the targets you set from the card's template on a hit, else what's under it now.
    let tokens = (!placedNow && hit && ctx.targets.length) ? ctx.targets : await tokensInTemplate(doc);
    if (getSetting("clearTargets")) clearTargets();

    // A natural 20 crits only the creature nearest the intersection (CRB 181; FAQ).
    const point = { x: doc.x, y: doc.y };
    const critToken = hit && nat === 20 ? nearestToPoint(tokens, point) : null;

    const damage = { normal: [], crit: [] };
    if (item.hasDamage && tokens.length) {
        const mode = await chooseMode(item);
        if (tokens.some(t => t !== critToken)) damage.normal = await rollDamageSections(item, false, { partIndex: mode?.index });
        if (critToken) damage.crit = await rollDamageSections(item, true, { partIndex: mode?.index });
    }

    // The DC drops by the attack's penalties (CRB 181): range, and the bar's full attack and so on.
    const base = itemSaveDC(item);
    const parts = [];
    if (range?.penalty) parts.push({ label: "range", value: range.penalty });
    parts.push(...barPenalties(optionsUsed));
    const dc = base + parts.reduce((s, p) => s + p.value, 0);
    const type = itemSaveType(item, { explode: true });
    const eff2 = saveEffect(item.system.save?.descriptor, { explode: true });

    const targets = tokens.map(t => ({ ...targetData(t), critTarget: t === critToken }));
    await send("processSave", {
        workflowId: foundry.utils.randomID(),
        kind: KIND.EXPLODE,
        userId: game.user.id,
        time: Date.now(),
        attacker: attackerData(actor, attackerToken),
        item: itemData(item),
        attack: { total: roll.total, nat, eff, penalty: range?.penalty ?? 0, distance, hit, notes },
        scatter: scattered,
        save: { type, label: SAVE_LABEL[type], dc, base, parts, onSave: eff2.onSave, flagged: false, note: "" },
        cover, options: optionsUsed, nonlethal,
        properties: damageProperties(item),
        targets, damage
    });
}

/* ---------- blast, line and automatic mode ---------- */

async function areaAttackFlow(ctx, kind) {
    const { actor, item, roll, attackerToken, cover, optionsUsed, nonlethal, autoMode } = ctx;
    const spec = areaOf(item, { autoMode });
    if (!spec) return attackFlowLayer1(ctx);
    let doc = freshTemplate(item);
    const placedNow = !doc;
    if (!doc) doc = await placeTemplate(item, spec);
    if (!doc) return;
    consumeTemplate(item);

    let tokens = (!placedNow && ctx.targets.length) ? ctx.targets : await tokensInTemplate(doc, { excludeActorUuid: actor.uuid, excludeOrigin: true });
    tokens = sortByDistance(tokens, attackerToken);
    if (getSetting("clearTargets")) clearTargets();

    // Blast: a d20 per creature at -2 (CRB 180). Line: one roll against every creature; only the
    // first can be crit (CRB 181). Automatic: a d20 per creature at the full-attack penalty, no crits.
    const nat0 = naturalD20(roll);
    const mod = roll.total - (nat0 ?? 0);
    const fullOn = optionsUsed.includes("fullAttack");
    const penalty = kind === KIND.BLAST ? -2 : (kind === KIND.AUTOMATIC && !fullOn ? -4 : 0);
    const penaltyLabel = kind === KIND.BLAST ? "blast" : "automatic";
    const results = [];
    for (const [i, tok] of tokens.entries()) {
        let total = roll.total;
        let nat = nat0;
        if (kind !== KIND.LINE && i > 0) {
            const r = await new Roll(`1d20 + ${mod}`).evaluate();
            showDice(r);
            total = r.total;
            nat = r.dice[0]?.total ?? null;
        }
        const noCrit = kind === KIND.AUTOMATIC || (kind === KIND.LINE && i > 0);
        const res = resolveTarget({ item, roll, attackerToken, targetToken: tok, cover, total, nat, penalty, penaltyLabel, noCrit, skipRange: true });
        if (kind === KIND.LINE && i === 0) res.notes.push("first in the line");
        results.push(res);
    }

    const needNormal = results.some(r => r.result === RESULT.HIT);
    const needCrit = results.some(r => r.result === RESULT.CRIT);
    const damage = { normal: [], crit: [] };
    let mode = null;
    if (item.hasDamage && getSetting("autoRollDamage") && (needNormal || needCrit)) {
        mode = await chooseMode(item);
        if (needNormal) damage.normal = await rollDamageSections(item, false, { partIndex: mode?.index });
        if (needCrit) damage.crit = await rollDamageSections(item, true, { partIndex: mode?.index });
    }

    await send("processAttack", {
        workflowId: foundry.utils.randomID(),
        kind,
        userId: game.user.id,
        time: Date.now(),
        attacker: attackerData(actor, attackerToken),
        item: itemData(item),
        attack: { total: roll.total, nat: nat0, formula: roll.formula, acKey: pickAcKey(item), penalty },
        area: { t: spec.t, distance: spec.distance },
        cover, options: optionsUsed, nonlethal,
        properties: damageProperties(item),
        targets: results,
        damage, mode
    });
}

/* ---------- save effects and damage-only effects ---------- */

/** Does a damage roll for this item start a save (or damage-only) workflow? */
function damageFlow(item) {
    if (!getSetting("enabled")) return null;
    if (!isHandledItem(item?.actor, item)) return null;
    if (!item.hasDamage || item.system?.actionType === "heal") return null;
    const p = item.system?.properties ?? {};
    if (["explode", "blast", "line"].some(k => p[k]?.value)) return null; // their attack drives them
    if (item.hasSave && getSetting("automateSaves") && (!item.hasAttack || areaOf(item))) return KIND.SAVE;
    if (!item.hasSave && !item.hasAttack && getSetting("damageOnly")) return KIND.DAMAGE;
    return null;
}

/** Wrapper for ItemSFRPG.prototype.rollDamage (installed in main.js). */
export function wrapRollDamage(original) {
    return async function (eventArg = {}, options = {}) {
        const item = this;
        if (options?.rollMetadata?.scaWorkflowId) return original.call(this, eventArg, options);
        let kind = null;
        try {
            kind = damageFlow(item);
        } catch (err) {
            console.warn(`${MODULE_ID} |`, err);
        }
        const targets = kind ? currentTargets() : [];
        if (!kind || !targets.length) return original.call(this, eventArg, options);
        if (!gmConnected()) {
            warnNoGM();
            return original.call(this, eventArg, options);
        }

        // Capture synchronously.
        const actor = item.actor;
        const attackerToken = findAttackerToken(actor);
        const cover = bar.consumeCover();
        const workflowId = foundry.utils.randomID();
        pendingDamage.set(workflowId, { normal: [], crit: [] });
        let result, sections;
        try {
            result = await original.call(this, eventArg, {
                ...options,
                rollMetadata: { ...(options?.rollMetadata ?? {}), scaWorkflowId: workflowId, scaCrit: false }
            });
            sections = pendingDamage.get(workflowId)?.normal ?? [];
        } finally {
            pendingDamage.delete(workflowId);
        }
        if (!sections?.length) return result; // the roll was cancelled
        if (getSetting("clearTargets")) clearTargets();
        consumeTemplate(item);

        let save = null;
        if (kind === KIND.SAVE) {
            const type = itemSaveType(item);
            const eff = saveEffect(item.system.save?.descriptor);
            save = { type, label: SAVE_LABEL[type] ?? type, dc: itemSaveDC(item), base: null, parts: [], ...eff };
        }
        const hasArea = !!areaOf(item);
        const out = targets.map(t => {
            const d = targetData(t);
            const w = hasArea ? null : saveRangeWarning(item, attackerToken, t);
            if (w) d.rangeWarning = w;
            return d;
        });

        await send("processSave", {
            workflowId,
            kind,
            userId: game.user.id,
            time: Date.now(),
            attacker: attackerData(actor, attackerToken),
            item: itemData(item),
            save, cover, options: [],
            nonlethal: !!item.system?.properties?.nonlethal?.value,
            properties: damageProperties(item),
            targets: out,
            damage: { normal: sections, crit: [] }
        });
        return result;
    };
}
