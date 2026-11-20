/**
 * Areas: which template belongs to which item, placing one when the module needs it,
 * the tokens inside it, and where a missed grenade lands.
 *
 * sfrpg's "Place template" button creates a MeasuredTemplate with no link to the item, so the
 * module wraps ItemSFRPG.placeAbilityTemplate to remember which item is being placed and stamps
 * the template with a flag as it's created. Templates the module places itself carry the flag
 * from the start.
 */
import { MODULE_ID } from "./constants.js";
import { getSetting } from "./settings.js";
import { areaSpec, scatterStep } from "./logic.js";

/** A template is reused by the next roll of its item for this long. */
const FRESH_MS = 3 * 60 * 1000;

/** A placement started from sfrpg's card button, waiting for its document. */
let pending = null;
/** The latest unused template per item on this client: itemUuid -> { id, sceneId, at }. */
const lastTemplate = new Map();
/** Callers waiting for an item's template to be created: itemUuid -> resolve. */
const waiters = new Map();

export const itemDescription = (item) => item?.system?.description?.value ?? "";

/** The item's area (shape and size), or null. autoMode: the bar's automatic-fire toggle. */
export function areaOf(item, { autoMode = false } = {}) {
    if (!item?.system) return null;
    return areaSpec(item.system, { autoMode, description: itemDescription(item) });
}

/** sfrpg's compendium copy of an item with the same name (NPC grenades often carry no radius). */
const twins = new Map();
export async function compendiumTwin(item) {
    const key = String(item?.name ?? "").trim().toLowerCase();
    if (!key) return null;
    if (twins.has(key)) return twins.get(key);
    let sys = null;
    try {
        const pack = game.packs.get("sfrpg.equipment");
        const index = await pack?.getIndex();
        const entry = index?.find(e => String(e.name).trim().toLowerCase() === key);
        if (entry) sys = (await pack.getDocument(entry._id))?.system ?? null;
    } catch (err) {
        console.warn(`${MODULE_ID} | compendium lookup failed`, err);
    }
    twins.set(key, sys);
    return sys;
}

/** An explode weapon's area, filling a missing radius from the compendium copy (5 ft if none). */
export async function explodeArea(item) {
    const spec = areaOf(item);
    if (!spec?.guessed) return spec;
    const twin = await compendiumTwin(item);
    const t = twin ? areaSpec(twin, {}) : null;
    if (t?.kind === "explode" && !t.guessed) return { ...spec, distance: t.distance, guessed: false, fromCompendium: true };
    return spec;
}

/* ---------- template <-> item ---------- */

/**
 * Wrapper for ItemSFRPG.prototype.placeAbilityTemplate (installed in main.js). The item is
 * remembered for as long as the preview is open, however long the player takes, and for a few
 * seconds after it's placed (sfrpg creates the template without awaiting it).
 */
export function wrapPlaceAbilityTemplate(original) {
    return async function (...args) {
        pending = { itemUuid: this.uuid, actorUuid: this.actor?.uuid ?? null, placedAt: null };
        const mine = pending;
        let placed = false;
        try {
            placed = await original.apply(this, args);
            return placed;
        } finally {
            if (pending === mine) {
                if (placed) pending.placedAt = Date.now();
                else pending = null;
            }
        }
    };
}

/** Hook: preCreateMeasuredTemplate (creator's client). Stamp a card-placed template with its item. */
export function onPreCreateTemplate(doc) {
    if (!pending) return;
    if (pending.placedAt && Date.now() - pending.placedAt > 10000) {
        pending = null;
        return;
    }
    if (doc.flags?.[MODULE_ID]?.itemUuid) return;
    doc.updateSource({ [`flags.${MODULE_ID}`]: { itemUuid: pending.itemUuid, actorUuid: pending.actorUuid } });
    pending = null;
}

/**
 * Foundry v14 stores a measured template as a Region (flag core.MeasuredTemplate, same id), so
 * only the Region hooks fire. These pass template Regions on to the template handlers.
 */
const isTemplateRegion = (doc) => !!doc?.flags?.core?.MeasuredTemplate;
export function onPreCreateRegion(doc) {
    if (isTemplateRegion(doc)) onPreCreateTemplate(doc);
}
export function onCreateRegion(doc, options, userId) {
    if (!isTemplateRegion(doc)) return;
    const tpl = doc.parent?.templates?.get?.(doc.id) ?? doc;
    return onCreateTemplate(tpl, options, userId);
}

const handled = new Set();

/** Hook: createMeasuredTemplate (v13) or, through onCreateRegion, v14. On the creator's client: remember it, wake waiters, target tokens. */
export async function onCreateTemplate(doc, options, userId) {
    const authorId = userId ?? doc.author?.id ?? doc.user?.id;
    if (authorId !== game.user.id) return;
    if (handled.has(doc.id)) return;
    handled.add(doc.id);
    const flags = doc.flags?.[MODULE_ID];
    if (!flags?.itemUuid) return;
    lastTemplate.set(flags.itemUuid, { id: doc.id, sceneId: doc.parent?.id, at: Date.now() });
    const wake = waiters.get(flags.itemUuid);
    if (wake) {
        waiters.delete(flags.itemUuid);
        wake(doc);
    }
    if (flags.noTarget) return;
    try {
        if (!getSetting("templateTargets")) return;
        const tokens = await tokensInTemplate(doc, { excludeActorUuid: flags.actorUuid, excludeOrigin: ["cone", "ray"].includes(doc.t) });
        canvas.tokens.setTargets(tokens.map(t => t.id), { mode: "replace" });
    } catch (err) {
        console.warn(`${MODULE_ID} | could not target the template's tokens`, err);
    }
}

/** The item's latest unused template on this scene, or null. */
export function freshTemplate(item) {
    const entry = lastTemplate.get(item?.uuid);
    if (!entry || Date.now() - entry.at > FRESH_MS) return null;
    if (entry.sceneId !== canvas.scene?.id) return null;
    return canvas.scene.templates.get(entry.id) ?? null;
}

/** Mark the item's template as used, so the next roll asks for a new one. */
export function consumeTemplate(item) {
    lastTemplate.delete(item?.uuid);
}

function waitForTemplate(itemUuid, ms = 120000) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            waiters.delete(itemUuid);
            resolve(null);
        }, ms);
        waiters.set(itemUuid, (doc) => {
            clearTimeout(timer);
            resolve(doc);
        });
    });
}

/**
 * Open sfrpg's template preview for an area the module needs (a grenade's burst, a blast cone,
 * a line). Built here rather than through item.placeAbilityTemplate because sfrpg's version reads
 * the browser's current event, which doesn't exist after a roll. Resolves with the template
 * document, or null if the player right-clicks to cancel.
 */
export async function placeTemplate(item, spec, { noTarget = true } = {}) {
    const AbilityTemplate = game.sfrpg?.AbilityTemplate;
    if (!AbilityTemplate || !canvas.scene) return null;
    const defaults = CONFIG.MeasuredTemplate.defaults;
    const data = {
        t: spec.t,
        user: game.user.id,
        distance: spec.distance,
        direction: 0,
        x: 0,
        y: 0,
        fillColor: game.user.color?.css ?? game.user.color,
        texture: null,
        _id: foundry.utils.randomID(16),
        hidden: false,
        flags: { [MODULE_ID]: { itemUuid: item.uuid, actorUuid: item.actor?.uuid ?? null, kind: spec.kind, noTarget } }
    };
    if (spec.t === "cone") data.angle = defaults.angle;
    if (spec.t === "rect") {
        data.distance = Math.hypot(spec.distance, spec.distance);
        data.direction = 45;
    }
    if (spec.t === "ray") data.width = (defaults.width ?? 1) * canvas.dimensions.distance;

    const doc = new CONFIG.MeasuredTemplate.documentClass(data, { parent: canvas.scene });
    const preview = new AbilityTemplate(doc);
    ui.notifications.info(`${item.name}: place the ${spec.kind === "explode" ? "burst" : spec.t === "ray" ? "line" : "area"} (left-click; right-click cancels; mouse wheel turns it).`);
    const created = waitForTemplate(item.uuid);
    const placed = await preview.drawPreview();
    if (!placed) {
        waiters.delete(item.uuid);
        return null;
    }
    await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [doc.toObject(false)]);
    return created;
}

/* ---------- tokens and distances ---------- */

async function waitForObject(doc, ms = 1500) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        const o = doc.object;
        if (o && (o.shape || ["circle", "cone"].includes(doc.t))) return o;
        await new Promise(r => setTimeout(r, 50));
    }
    return doc.object ?? null;
}

function isOut(token) {
    const a = token.actor;
    if (!a) return true;
    if (a.statuses?.has?.(CONFIG.specialStatusEffects.DEFEATED)) return true;
    return !!token.combatant?.defeated;
}

/**
 * Tokens in the squares a template highlights (sfrpg's Starfinder shapes). Leaves out
 * defeated tokens, tokens this user can't see, and, for cones and lines, the caster.
 */
export async function tokensInTemplate(doc, { excludeActorUuid = null, excludeOrigin = false } = {}) {
    const obj = await waitForObject(doc);
    if (!obj?.getTokensWithin) return [];
    let tokens = obj.getTokensWithin();
    tokens = tokens.filter(t => t.actor && !isOut(t) && (game.user.isGM || t.visible));
    if (excludeOrigin && excludeActorUuid) tokens = tokens.filter(t => t.actor?.uuid !== excludeActorUuid);
    return tokens;
}

/** The grid squares (offsets) a token covers. */
function squaresOf(token) {
    try {
        const o = token.document.getOccupiedGridSpaceOffsets?.();
        if (o?.length) return o;
    } catch { /* fall through */ }
    return [canvas.grid.getOffset(token.center)];
}

/** The squares that touch a point: four around an intersection, else the one it's in. */
function squaresAtPoint(p) {
    const e = 2;
    const out = new Map();
    for (const [dx, dy] of [[e, e], [-e, e], [e, -e], [-e, -e]]) {
        const o = canvas.grid.getOffset({ x: p.x + dx, y: p.y + dy });
        out.set(`${o.i},${o.j}`, o);
    }
    return [...out.values()];
}

/** Distance in feet from a token to an aimed point (its nearest square to the nearest square touching the point). */
export function distanceToPoint(token, point) {
    if (!token || !point) return null;
    let best = Infinity;
    for (const a of squaresOf(token)) {
        for (const b of squaresAtPoint(point)) {
            const d = canvas.grid.measurePath([canvas.grid.getCenterPoint(a), canvas.grid.getCenterPoint(b)]).distance;
            if (d < best) best = d;
        }
    }
    return Number.isFinite(best) ? best : null;
}

/** The token nearest an aimed point (an explode crit lands on it, CRB 181). */
export function nearestToPoint(tokens, point) {
    let best = null, bestD = Infinity;
    for (const t of tokens) {
        for (const o of squaresOf(t)) {
            const c = canvas.grid.getCenterPoint(o);
            const d = Math.hypot(c.x - point.x, c.y - point.y);
            if (d < bestD - 0.5) {
                bestD = d;
                best = t;
            }
        }
    }
    return best;
}

/** Sort tokens nearest the attacker first (blast, line and automatic resolve in that order). */
export function sortByDistance(tokens, from) {
    const dist = (t) => {
        let best = Infinity;
        for (const a of squaresOf(from)) for (const b of squaresOf(t)) {
            const d = canvas.grid.measurePath([canvas.grid.getCenterPoint(a), canvas.grid.getCenterPoint(b)]).distance;
            best = Math.min(best, d);
        }
        return best;
    };
    return [...tokens].map(t => ({ t, d: from ? dist(t) : 0 })).sort((x, y) => x.d - y.d).map(x => x.t);
}

/**
 * A missed grenade: roll 1d8 for direction and 1d4 squares (CRB 245), move the template, and
 * return what happened.
 */
export async function scatter(doc, attackerToken) {
    const d8 = (await new Roll("1d8").evaluate()).total;
    const d4 = (await new Roll("1d4").evaluate()).total;
    const aim = { x: doc.x, y: doc.y };
    const from = attackerToken?.center ?? aim;
    const step = scatterStep(aim, from, d8, d4);
    const s = canvas.grid.size;
    await moveTemplate(doc, step.di * s, step.dj * s);
    await new Promise(r => setTimeout(r, 250));
    const moved = doc.parent?.templates?.get?.(doc.id) ?? doc;
    return { d8, d4, eighth: step.eighth, squares: d4, from: aim, to: { x: moved.x, y: moved.y } };
}

/**
 * Move a template. In v14 the template is a Region, and updating the template's x and y doesn't
 * move it, so the Region's shapes are shifted instead.
 */
export async function moveTemplate(doc, dx, dy) {
    const region = doc.parent?.regions?.get?.(doc.id);
    if (region && isTemplateRegion(region)) {
        const shapes = region.toObject().shapes.map(sh => {
            const out = { ...sh };
            if (typeof out.x === "number") out.x += dx;
            if (typeof out.y === "number") out.y += dy;
            if (Array.isArray(out.points)) out.points = out.points.map((v, i) => v + (i % 2 ? dy : dx));
            return out;
        });
        await region.update({ shapes });
        return;
    }
    await doc.update({ x: doc.x + dx, y: doc.y + dy });
}
