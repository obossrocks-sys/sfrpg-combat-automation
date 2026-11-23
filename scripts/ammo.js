/**
 * Layer 4: ammunition and limited uses, on the roller's client (they own the item).
 *
 * What sfrpg 14 already does: an attack spends the weapon's usage (consumeCapacity, before the
 * attackRolled hook; Ctrl skips it); reloading refills capacity; spells spend slots and innate
 * uses in useSpell; activated items spend uses when activated.
 * What it leaves out, and this file adds:
 *  - an attack with an empty weapon still rolls: the module stops it (Ctrl still overrides);
 *  - a thrown grenade spends its "drawn" capacity but never leaves the inventory: the module
 *    takes one from the quantity and draws the next if any are left;
 *  - automatic mode spends two shots' worth per creature, nearest first, stops when it can't pay
 *    for the next creature, and uses all the remaining ammunition (CRB 180);
 *  - abilities (feats) with limited uses that attack or roll damage never spend a use: the module
 *    spends one when sfrpg didn't.
 */
import { MODULE_ID } from "./constants.js";
import { getSetting } from "./settings.js";
import { tokenDistance } from "./rules.js";
import { isNpc, isArmed, npcOn, weaponFlag, npcSpare, askReload, reloadNow, noSpareMessage } from "./npc-ammo.js";

const on = () => {
    try {
        return !!getSetting("ammo");
    } catch (err) {
        return false;
    }
};

/**
 * Who tracks ammunition and uses: player characters and drones, and (0.5.0) NPCs armed by the
 * module (npc-ammo.js): their armed weapons and grenades and their abilities. An NPC that was never
 * armed, an integrated weapon and a weapon added outside the module stay the GM's.
 */
const tracked = (item) => {
    const actor = item?.actor;
    if (["character", "drone"].includes(actor?.type)) return true;
    if (!isNpc(actor) || !npcOn() || !isArmed(actor)) return false;
    if (item.type !== "weapon") return true;
    const f = weaponFlag(item);
    return !!f && f.mode !== "unlimited";
};

/** An armed NPC's weapon that can't pay for the shot (not a grenade). */
function npcEmpty(item) {
    if (!isNpc(item?.actor) || !tracked(item) || isGrenade(item) || !usesAmmo(item)) return false;
    return ammoLeft(item) < usageOf(item);
}

export const isGrenade = (item) => item?.type === "weapon" && item.system?.weaponType === "grenade";

/** Ammunition one shot uses, with sfrpg's usage modifiers. 0 when the weapon uses none. */
export function usageOf(item) {
    const u = item?.system?.usage;
    if (!u || !["action", "shot"].includes(u.per)) return 0;
    const base = Number(u.value) || 0;
    if (base <= 0) return 0;
    try {
        return Number(item._calculateAmmoUsageWithModifiers?.(base)) || base;
    } catch (err) {
        return base;
    }
}

export function usesAmmo(item) {
    if (item?.type !== "weapon" || usageOf(item) <= 0) return false;
    return !!item.requiresCapacityItem?.() || Number(item.system?.capacity?.max) > 0;
}

export const ammoLeft = (item) => Number(item?.getCurrentCapacity?.() ?? item?.system?.capacity?.value ?? 0) || 0;

/** Why this weapon can't attack right now, or null. */
export function emptyMessage(item) {
    if (!on() || item?.type !== "weapon" || !tracked(item)) return null;
    if (isGrenade(item) && (Number(item.system?.quantity) || 0) < 1) return `${item.name}: none left.`;
    if (!usesAmmo(item)) return null;
    const need = usageOf(item);
    const left = ammoLeft(item);
    if (left >= need) return null;
    if (isGrenade(item)) return `${item.name}: draw one first (Reload on the sheet).`;
    return `${item.name} is out of ammunition (${left} left, a shot uses ${need}). Reload it (a move action), or Ctrl-click to attack anyway.`;
}

/* ---------- limited uses (abilities) ---------- */

/**
 * Uses to track, or null. Only abilities (feats): weapons use ammo, spells are spent by useSpell,
 * and consumables and other gear are spent by sfrpg's Use button.
 */
function usesOf(item) {
    if (item?.type !== "feat") return null;
    let has = false;
    try {
        has = !!item.hasUses?.();
    } catch (err) {
        has = false;
    }
    if (!has) return null;
    const value = Number(item.getRemainingUses?.() ?? item.system?.uses?.value);
    return Number.isFinite(value) ? { value } : null;
}

/** Before using an ability: null if fine, else the message. */
export function noUsesMessage(item) {
    if (!on() || !tracked(item)) return null;
    const u = usesOf(item);
    return u && u.value <= 0 ? `${item.name} has no uses left.` : null;
}

/** After using it: spend a use unless sfrpg already did. */
export async function spendUse(item, before) {
    if (!on() || !before || !tracked(item)) return;
    const now = usesOf(item);
    if (!now || now.value < before.value) return;
    await item.update({ "system.uses.value": Math.max(0, before.value - 1) });
}

export const usesBefore = (item) => (on() && tracked(item) ? usesOf(item) : null);

/* ---------- grenades ---------- */

/** After a throw: one fewer grenade; draw the next if there's one left. */
async function afterGrenade(item) {
    const qty = Math.max(0, (Number(item.system?.quantity) || 0) - 1);
    await item.update({ "system.quantity": qty, "system.capacity.value": qty > 0 ? Math.max(1, Number(item.system?.capacity?.max) || 1) : 0 });
    if (qty === 0) ui.notifications.info(`That was the last ${item.name}.`);
}

/** Wraps sfrpg's Item.rollAttack: the empty check before, grenades and uses after. */
export function wrapRollAttack(original) {
    return async function (options = {}) {
        const item = this;
        const skip = !!options?.disableDeductAmmo || !!options?.event?.ctrlKey;
        let msg = null;
        try {
            msg = (skip ? null : emptyMessage(item)) ?? noUsesMessage(item);
        } catch (err) {
            console.warn(`${MODULE_ID} |`, err);
        }
        // An NPC's empty weapon: the GM decides whether it spends its move action reloading.
        if (msg && !skip && npcEmpty(item)) {
            try {
                const spare = npcSpare(item);
                if (!spare) msg = noSpareMessage(item);
                else if (await askReload(item, spare, ammoLeft(item), usageOf(item))) {
                    await reloadNow(item, spare, usageOf(item));
                    msg = emptyMessage(item) ?? noUsesMessage(item);
                } else msg = `${item.name} left empty; no attack.`;
            } catch (err) {
                console.error(`${MODULE_ID} |`, err);
            }
        }
        if (msg) {
            ui.notifications.warn(msg);
            return null;
        }
        const uses = usesBefore(item);
        const capBefore = ammoLeft(item);
        // Did the attack roll? (sfrpg's capacity update may not have landed when it returns.)
        let rolled = false;
        const hookId = Hooks.on("attackRolled", (data) => {
            if (data?.item === item || (data?.item?.id === item.id && data?.item?.parent === item.parent)) rolled = true;
        });
        let result;
        try {
            result = await original.call(this, options);
        } finally {
            Hooks.off("attackRolled", hookId);
        }
        if (!rolled) return result;
        try {
            if (isGrenade(item) && on() && !skip && tracked(item)) {
                // Let sfrpg's own capacity update land first, or it would undo the draw.
                const until = Date.now() + 2000;
                while (ammoLeft(item) >= capBefore && capBefore > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 100));
                await afterGrenade(item);
            }
            if (uses) await spendUse(item, uses);
        } catch (err) {
            console.error(`${MODULE_ID} |`, err);
        }
        return result;
    };
}

/* ---------- automatic mode ---------- */

/**
 * Automatic mode (CRB 180): two shots' worth per creature, nearest first; ties at the cut are
 * picked at random; the attack uses all the remaining ammunition. sfrpg has already spent one
 * shot by the time the attack hook runs. Returns { tokens, info } and spends the rest.
 */
export async function automaticAmmo(item, tokens, attackerToken) {
    if (!on() || !usesAmmo(item) || !tracked(item)) return { tokens, info: null };
    const shot = usageOf(item);
    const left = ammoLeft(item);
    const available = left + shot;
    const per = shot * 2;
    const can = Math.floor(available / per);
    let chosen = tokens;
    let skipped = [];
    if (tokens.length > can) {
        const dist = (t) => (attackerToken ? tokenDistance(attackerToken, t) : 0);
        const withD = tokens.map(t => ({ t, d: dist(t) }));
        if (can > 0 && withD[can - 1].d === withD[can]?.d) {
            // Equidistant at the cut: pick at random among them (CRB 180).
            const d = withD[can - 1].d;
            const before = withD.filter(x => x.d < d);
            const tied = withD.filter(x => x.d === d).sort(() => Math.random() - 0.5);
            const after = withD.filter(x => x.d > d);
            const ordered = [...before, ...tied, ...after];
            chosen = ordered.slice(0, can).map(x => x.t);
            skipped = ordered.slice(can).map(x => x.t);
        } else {
            chosen = withD.slice(0, can).map(x => x.t);
            skipped = withD.slice(can).map(x => x.t);
        }
    }
    if (left > 0) await item.consumeCapacity?.(left);
    return {
        tokens: chosen,
        info: { shot, per, available, attacked: chosen.length, notAttacked: skipped.map(t => t.document?.name ?? t.name), spent: available }
    };
}
