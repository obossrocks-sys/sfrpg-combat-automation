/**
 * v0.5.0: NPC ammunition. NPCs follow the players' ammunition rules (layer 4).
 *
 * sfrpg stores an NPC weapon's charges two ways: most Alien Archive weapons keep them on the weapon
 * with the ammunition type cleared (so sfrpg's Reload refills them for free), and a few carry a real
 * battery or cartridge item, as the players' weapons do. Arming an NPC (when its token is placed, or
 * in the one-time pass over placed tokens) makes every weapon work the players' way:
 *  - the ammunition type comes back from the compendium weapon of the same name;
 *  - a full battery, tank or magazine of rounds is loaded into the weapon as a real ammunition item;
 *  - spares: the ammunition the stat block lists as goods becomes real ammunition items; with none
 *    listed, 2 spare loads for small arms, longarms and sniper weapons, 1 for the rest;
 *  - grenades are drawn; integrated weapons (robots) stay unlimited, as do natural attacks.
 * Unlinked tokens keep their own count; a linked token arms its actor once. Looting the body shows
 * the magazine's charges, the spent batteries and the unspent spares.
 */
import { MODULE_ID } from "./constants.js";
import { getSetting } from "./settings.js";
import * as L from "./npc-ammo-logic.js";

const FLAG = "npcAmmo";
const AMMO_SLOT = { acceptsType: ["ammunition"], affectsEncumbrance: true, amount: 1, subtype: "ammunitionSlot", type: "slot", weightProperty: "" };
const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

export const isNpc = (actor) => ["npc", "npc2"].includes(actor?.type);
export const isArmed = (actor) => !!actor?.flags?.[MODULE_ID]?.[FLAG]?.armed;
export const weaponFlag = (item) => item?.flags?.[MODULE_ID]?.[FLAG] ?? null;
export const npcOn = () => {
    try {
        return !!getSetting("npcAmmo") && !!getSetting("ammo");
    } catch (err) {
        return false;
    }
};

/* ---------- the compendium ---------- */

let cache = null;
async function packData() {
    if (cache) return cache;
    const pack = game.packs.get("sfrpg.equipment");
    if (!pack) throw new Error("sfrpg.equipment not found");
    const idx = await pack.getIndex({ fields: ["system.ammunitionType", "system.capacity", "system.useCapacity", "system.level", "system.quantity", "system.weaponType"] });
    const weapons = [];
    const ammo = [];
    for (const e of idx) {
        const s = e.system ?? {};
        if (e.type === "weapon") weapons.push({ id: e._id, name: e.name, ammunitionType: s.ammunitionType || "", capacityMax: Number(s.capacity?.max) || 0 });
        else if (e.type === "ammunition") ammo.push({
            id: e._id, name: e.name, uuid: e.uuid ?? `Compendium.sfrpg.equipment.Item.${e._id}`, ammunitionType: s.ammunitionType || "",
            useCapacity: !!s.useCapacity, capacityMax: Number(s.capacity?.max) || 0, level: Number(s.level) || 0, quantity: Number(s.quantity) || 1
        });
    }
    cache = { pack, weapons, ammo, docs: new Map() };
    return cache;
}

async function ammoObject(entry, quantity) {
    const c = await packData();
    if (!c.docs.has(entry.id)) c.docs.set(entry.id, await c.pack.getDocument(entry.id));
    const obj = c.docs.get(entry.id).toObject();
    delete obj._id;
    obj.system.quantity = quantity;
    if (entry.useCapacity) obj.system.capacity = { max: entry.capacityMax, value: entry.capacityMax };
    obj._stats = { ...(obj._stats ?? {}), compendiumSource: entry.uuid };
    return obj;
}

/* ---------- planning ---------- */

/** The item (other than a plain container) that holds this one, or null. */
function holder(actor, item) {
    return actor.items.find(x => x.id !== item.id && (x.system?.container?.contents ?? []).some(c => c.id === item.id)) ?? null;
}
const loose = (actor, item) => {
    const h = holder(actor, item);
    return !h || h.type === "container";
};

function classify(item, featNames, c) {
    if (item.type !== "weapon" || weaponFlag(item)) return null;
    const s = item.system ?? {};
    if (s.weaponType === "grenade") return { mode: "grenade" };
    const u = s.usage;
    if (!u || !["action", "shot"].includes(u.per) || !(Number(u.value) > 0)) return null;
    if (L.isIntegrated(item.name, featNames)) return { mode: "unlimited" };
    const src = L.matchWeapon(item.name, c.weapons);
    const type = s.ammunitionType || src?.ammunitionType || "";
    const capMax = Number(s.capacity?.max) || src?.capacityMax || 0;
    const load = type ? L.pickAmmo(type, capMax, c.ammo) : null;
    if (load && capMax > 0) return { mode: "ammo", type, capMax, load, setType: s.ammunitionType !== type };
    return capMax > 0 ? { mode: "internal", capMax, clearType: !!s.ammunitionType } : null;
}

/** What arming this actor would do: { weapons, goods, spares, lines }. Arms only weapons not yet armed. */
export async function planActor(actor) {
    const c = await packData();
    const featNames = actor.items.filter(i => i.type === "feat").map(i => i.name);
    const weapons = [];
    for (const item of actor.items) {
        const m = classify(item, featNames, c);
        if (m) weapons.push({ item, ...m });
    }
    const ammoW = weapons.filter(w => w.mode === "ammo");
    const lines = [];
    // Spares the stat block lists as goods.
    const goods = [];
    for (const g of actor.items) {
        if (g.type !== "goods") continue;
        const p = L.parseGoodsAmmo(g.name, g.system?.quantity);
        if (!p) continue;
        const type = p.type ?? ammoW.find(w => !w.load.useCapacity)?.type ?? null;
        if (!type) continue;
        let target = null;
        let qty = 0;
        if (p.size) {
            target = L.packOfSize(type, p.size, c.ammo) ?? L.pickAmmo(type, p.size, c.ammo);
            qty = p.count;
        } else {
            target = L.pickAmmo(type, 0, c.ammo);
            qty = p.rounds ?? (p.packs * (target?.quantity || 1));
        }
        if (target && qty > 0) goods.push({ goods: g, target, quantity: qty });
    }
    for (const i of L.duplicateGoods(goods.map(g => ({ name: g.goods.name, targetId: g.target.id, targetName: g.target.name })))) goods[i].drop = true;
    // Ammunition items already carried loose count as spares too.
    const carried = actor.items.filter(i => i.type === "ammunition" && loose(actor, i));
    const typesWithSpares = new Set([...goods.map(g => g.target.ammunitionType), ...carried.map(i => i.system?.ammunitionType)]);
    const spares = new Map();
    const addSpare = (entry, qty, why) => {
        const k = entry.id;
        const cur = spares.get(k) ?? { entry, quantity: 0, why };
        cur.quantity += qty;
        spares.set(k, cur);
    };
    for (const w of ammoW) {
        if (typesWithSpares.has(w.type)) continue;
        const loads = L.defaultSpareLoads(w.item.system?.weaponType);
        addSpare(w.load, w.load.useCapacity ? loads : loads * w.capMax, "default");
    }
    for (const w of weapons) {
        const n = w.item.name;
        if (w.mode === "ammo") {
            const cur = w.item.system?.ammunitionType ? w.item.getCapacityItem?.() : null;
            w.topUp = cur ?? null;
            const what = w.load.useCapacity ? `${w.load.name} (${w.load.capacityMax} charges)` : `${w.capMax} × ${w.load.name}`;
            lines.push(`${n}: ${cur ? `top up the loaded ${cur.name}` : `load ${what}`}${w.setType ? `; ammo type set to ${w.type}` : ""}`);
        } else if (w.mode === "internal") {
            lines.push(`${n}: no matching ammunition item; charges stay on the weapon, filled to ${w.capMax}; no spares`);
        } else if (w.mode === "grenade") {
            const q = Number(w.item.system?.quantity) || 0;
            lines.push(`${n}: ${q < 1 ? "quantity 0 → 1, " : ""}drawn (${Math.max(1, q)})`);
        } else if (w.mode === "unlimited") {
            lines.push(`${n}: integrated, unlimited`);
        }
    }
    for (const g of goods) lines.push(g.drop ? `goods "${g.goods.name}" dropped (the same ammunition as the "${g.target.name}" line)` : `goods "${g.goods.name}" → ${g.quantity} × ${g.target.name} (ammunition item)`);
    for (const s of spares.values()) lines.push(`spare: ${s.quantity} × ${s.entry.name}`);
    return { actor, weapons, goods, spares: [...spares.values()], lines };
}

/* ---------- arming ---------- */

export async function applyPlan(plan) {
    const { actor } = plan;
    const ammoW = plan.weapons.filter(w => w.mode === "ammo" && !w.topUp);
    const create = [];
    for (const w of ammoW) {
        const obj = await ammoObject(w.load, w.load.useCapacity ? 1 : w.capMax);
        foundry.utils.setProperty(obj, `flags.${MODULE_ID}.${FLAG}.loadedIn`, w.item.id);
        create.push(obj);
    }
    for (const g of plan.goods.filter(x => !x.drop)) create.push(await ammoObject(g.target, g.quantity));
    for (const s of plan.spares) create.push(await ammoObject(s.entry, s.quantity));
    if (plan.goods.length) await actor.deleteEmbeddedDocuments("Item", plan.goods.map(g => g.goods.id));
    const made = create.length ? await actor.createEmbeddedDocuments("Item", create) : [];
    const loadedFor = new Map(made.filter(i => weaponFlag(i)?.loadedIn).map(i => [weaponFlag(i).loadedIn, i]));
    const updates = [];
    for (const w of plan.weapons) {
        const s = w.item.system ?? {};
        const u = { _id: w.item.id, [`flags.${MODULE_ID}.${FLAG}`]: { mode: w.mode } };
        if (w.mode === "ammo") {
            u["system.ammunitionType"] = w.type;
            u["system.capacity.max"] = w.capMax;
            const loaded = loadedFor.get(w.item.id);
            if (loaded) {
                const storage = foundry.utils.deepClone(s.container?.storage ?? []);
                let index = storage.findIndex(x => x.acceptsType?.includes("ammunition"));
                if (index < 0) {
                    storage.push(foundry.utils.deepClone(AMMO_SLOT));
                    index = storage.length - 1;
                    u["system.container.storage"] = storage;
                }
                u["system.container.contents"] = [...(s.container?.contents ?? []).map(x => ({ ...x })), { id: loaded.id, index }];
            }
        } else if (w.mode === "internal") {
            u["system.capacity.value"] = w.capMax;
            if (w.clearType) u["system.ammunitionType"] = "";
        } else if (w.mode === "grenade") {
            const q = Math.max(1, Number(s.quantity) || 0);
            u["system.quantity"] = q;
            u["system.capacity.max"] = Math.max(1, Number(s.capacity?.max) || 1);
            u["system.capacity.value"] = Math.max(1, Number(s.capacity?.max) || 1);
        }
        updates.push(u);
    }
    // Top up what was already loaded.
    for (const w of plan.weapons.filter(x => x.mode === "ammo" && x.topUp)) {
        const t = w.topUp;
        updates.push(t.system?.useCapacity
            ? { _id: t.id, "system.capacity.value": Number(t.system?.capacity?.max) || w.load.capacityMax }
            : { _id: t.id, "system.quantity": w.capMax });
    }
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
    await actor.update({ [`flags.${MODULE_ID}.${FLAG}.armed`]: true, [`flags.${MODULE_ID}.${FLAG}.version`]: 1 });
    return plan;
}

/** Arm an NPC (idempotent: weapons already armed are left alone). */
export async function armActor(actor, { dryRun = false } = {}) {
    if (!isNpc(actor)) return null;
    const plan = await planActor(actor);
    if (!dryRun && (plan.weapons.length || plan.goods.length || plan.spares.length || !isArmed(actor))) await applyPlan(plan);
    return plan;
}

const isActiveGM = () => game.users?.activeGM?.id === game.user?.id;

/**
 * Two tabs logged in as the same GM both see the hook: each writes its own lock, waits for the
 * writes to settle, and only the tab whose lock stuck goes on.
 */
async function takeLock(actor) {
    const lock = foundry.utils.randomID();
    await actor.update({ [`flags.${MODULE_ID}.${FLAG}.lock`]: lock });
    await new Promise(r => setTimeout(r, 500));
    return actor.flags?.[MODULE_ID]?.[FLAG]?.lock === lock;
}

/** createToken: arm a newly placed NPC. */
export async function onCreateToken(tokenDoc) {
    if (!npcOn() || !isActiveGM()) return;
    const actor = tokenDoc?.actor;
    if (!isNpc(actor) || isArmed(actor)) return;
    try {
        if (await takeLock(actor) && !isArmed(actor)) await armActor(actor);
    } catch (err) {
        console.error(`${MODULE_ID} | arming ${actor?.name}`, err);
    }
}

/** createItem: a weapon given to an armed NPC is armed too (with default spares). */
export async function onCreateItem(item, options, userId) {
    if (!npcOn() || userId !== game.user?.id || item?.type !== "weapon") return;
    const actor = item.actor;
    if (!isNpc(actor) || !isArmed(actor) || weaponFlag(item)) return;
    try {
        if (await takeLock(actor) && !weaponFlag(actor.items.get(item.id))) await armActor(actor);
    } catch (err) {
        console.error(`${MODULE_ID} | arming ${item.name}`, err);
    }
}

/* ---------- the one-time pass over placed tokens ---------- */

/**
 * Plan (dryRun) or arm every NPC token already placed, outside the skipped scene folders.
 * Returns { lines, count }: one block per scene, identical unlinked tokens grouped.
 */
export async function armPlaced({ dryRun = true, skipFolders = ["Dev"], scenes = null } = {}) {
    const out = [];
    let count = 0;
    const doneLinked = new Set();
    const list = scenes ?? game.scenes.filter(s => !skipFolders.includes(s.folder?.name));
    for (const scene of list) {
        const groups = new Map();
        for (const t of scene.tokens) {
            const actor = t.actor;
            if (!isNpc(actor) || isArmed(actor)) continue;
            if (t.actorLink) {
                if (doneLinked.has(actor.id)) continue;
                doneLinked.add(actor.id);
            }
            const plan = await armActor(actor, { dryRun });
            if (!plan) continue;
            count++;
            const key = `${t.actorLink ? "linked " : ""}${t.name}|${plan.lines.join("|")}`;
            const g = groups.get(key) ?? { name: t.name, linked: t.actorLink, n: 0, lines: plan.lines };
            g.n++;
            groups.set(key, g);
        }
        if (!groups.size) continue;
        out.push(`## ${scene.name}`);
        for (const g of groups.values()) out.push(`- ${g.name}${g.n > 1 ? ` ×${g.n}` : ""}${g.linked ? " (linked)" : ""}: ${g.lines.length ? g.lines.join("; ") : "nothing to load"}`);
    }
    return { lines: out, count };
}

/* ---------- the reload prompt ---------- */

/** The best spare that can reload this weapon (as sfrpg's Reload would pick), or null. */
export function npcSpare(item) {
    const actor = item?.actor;
    if (!actor || !item.system?.ammunitionType) return null;
    const w = { ammunitionType: item.system.ammunitionType, current: Number(item.getCurrentCapacity?.()) || 0, capacityMax: Number(item.getMaxCapacity?.()) || 0 };
    const fits = actor.items.filter(n => n.type === "ammunition" && loose(actor, n) && L.spareFits({
        ammunitionType: n.system?.ammunitionType, useCapacity: !!n.system?.useCapacity,
        current: Number(n.getCurrentCapacity?.()) || 0, capacityMax: Number(n.getMaxCapacity?.()) || 0
    }, w));
    return fits.sort((a, b) => (Number(b.getCurrentCapacity?.()) || 0) - (Number(a.getCurrentCapacity?.()) || 0))[0] ?? null;
}

const who = (item) => item?.actor?.token?.name ?? item?.actor?.name ?? "The NPC";

/** Ask the GM: reload this empty NPC weapon now? true for yes. */
export async function askReload(item, spare, left, need) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return false;
    const choice = await DialogV2.wait({
        window: { title: "Reload?" },
        content: `<p><strong>${esc(who(item))}</strong>: ${esc(item.name)} is out of ammunition (${left} left; a shot uses ${need}).</p>`
            + `<p>Reload it with ${esc(spare.name)}? That takes its move action.</p>`,
        buttons: [
            { action: "reload", label: "Reload (move action)", default: true },
            { action: "leave", label: "Leave it empty" }
        ],
        rejectClose: false
    });
    return choice === "reload";
}

/** Reload with sfrpg's own Reload (its card says "Cost: Move Action") and wait for it to land. */
export async function reloadNow(item, spare, need) {
    const before = Number(item.getCurrentCapacity?.()) || 0;
    await item.reload?.();
    const until = Date.now() + 2000;
    while ((Number(item.getCurrentCapacity?.()) || 0) <= before && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    return (Number(item.getCurrentCapacity?.()) || 0) >= need;
}

export const noSpareMessage = (item) => `${who(item)}: ${item.name} is empty and it carries no spare ammunition. Ctrl-click to attack anyway.`;
