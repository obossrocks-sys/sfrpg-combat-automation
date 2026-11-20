/**
 * Saves: the DC, who rolls each target's save (its player, or the GM's client), Evasion and
 * spell resistance. The DC never goes to players: their prompt names the save, not the number.
 */
import { MODULE_ID } from "./constants.js";
import { getSetting } from "./settings.js";
import { executeAsUser } from "./socket.js";
import { SAVE_LABEL } from "./logic.js";
import { hasCondition, naturalD20 } from "./rules.js";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * The item's save DC. sfrpg computes it on the item (with the cast level for spells); when it
 * can't, use 10 + half the item level + the ability (Dex for grenades and ranged weapons,
 * Str for other thrown and melee; FAQ), or an NPC's ability DC.
 */
export function itemSaveDC(item) {
    const fromLabel = Number(item?.labels?.dcValue);
    if (Number.isFinite(fromLabel) && fromLabel > 0) return fromLabel;
    const actor = item?.actor;
    if (["npc", "npc2"].includes(actor?.type)) {
        const dc = Number(actor.system?.attributes?.abilityDC?.value);
        if (dc) return dc;
    }
    const sys = item?.system ?? {};
    const level = Number(sys.level) || 0;
    const thrown = !!sys.properties?.thrown?.value && sys.weaponType !== "grenade";
    const ability = thrown || sys.actionType === "mwak" ? "str" : "dex";
    return 10 + Math.floor(level / 2) + (actor?.system?.abilities?.[ability]?.mod ?? 0);
}

/** The save an item calls for ("reflex" for explode weapons with none set). */
export function itemSaveType(item, { explode = false } = {}) {
    const t = item?.system?.save?.type;
    if (t && SAVE_LABEL[t]) return t;
    return explode ? "reflex" : null;
}

/**
 * Evasion or Improved Evasion, read from the creature's features by name ("Evasion (Ex)",
 * "Improved Evasion (Ex) (Operative)"). It doesn't work while helpless or unable to move,
 * encumbered, or (PCs) in heavy or powered armor.
 * Returns { level: null | "evasion" | "improved", lost: reason or null }.
 */
export function evasionOf(actor) {
    if (!actor?.items) return { level: null, lost: null };
    let level = null;
    for (const i of actor.items) {
        const n = String(i.name ?? "").trim().toLowerCase();
        if (/^improved evasion\b/.test(n)) {
            level = "improved";
            break;
        }
        if (/^evasion(\s*\(|\s*$)/.test(n)) level = "evasion";
    }
    if (!level) return { level: null, lost: null };
    const blocked = ["helpless", "paralyzed", "pinned", "unconscious", "stunned", "encumbered", "overburdened"]
        .find(c => hasCondition(actor, c));
    if (blocked) return { level: null, lost: blocked, had: level };
    if (actor.type === "character") {
        const armor = actor.items.find(i => i.type === "equipment" && i.system?.equipped && ["heavy", "power"].includes(i.system?.armor?.type));
        if (armor) return { level: null, lost: armor.name, had: level };
    }
    return { level, lost: null };
}

/** A creature's spell resistance (NPCs keep it in traits.sr, PCs and drones in traits.spellResistance). */
export function spellResistanceOf(actor) {
    const t = actor?.system?.traits ?? {};
    return Number(t.sr) || Number(t.spellResistance?.value) || 0;
}

/** Caster level check against SR: d20 + caster level (CRB 263). */
export async function rollSpellResistance(caster, sr) {
    const cl = Number(caster?.system?.details?.cl?.value) || 0;
    const roll = await new Roll(`1d20 + ${cl}`).evaluate();
    return { sr, cl, d20: roll.dice[0]?.total ?? null, total: roll.total, overcome: roll.total >= sr };
}

/** The active player who should roll this creature's save, or null (the GM's client rolls). */
export function saveRoller(actor) {
    if (getSetting("playerSaves") !== "player") return null;
    if (!actor?.hasPlayerOwner) return null;
    const owners = game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
    return owners.find(u => u.character?.id === actor.id) ?? owners[0] ?? null;
}

/**
 * GM side: roll one creature's save. A PC's player gets a prompt; NPC saves are rolled quietly
 * here (the GM card shows them). PC saves the GM rolls still post to chat.
 * Returns { d20, total, formula, by } or null.
 */
export async function rollSaveFor(actor, type, { itemName = "", casterName = "" } = {}) {
    const user = saveRoller(actor);
    let res = null;
    let by = "gm";
    if (user) {
        const timeout = Math.max(5, Number(getSetting("saveTimeout")) || 30) * 1000;
        try {
            res = await Promise.race([
                executeAsUser("promptSave", user.id, { actorUuid: actor.uuid, type, itemName, casterName, timeout }),
                new Promise(r => setTimeout(() => r(null), timeout + 15000))
            ]);
        } catch (err) {
            console.warn(`${MODULE_ID} | save prompt failed`, err);
            res = null;
        }
        by = res ? `player:${user.name}` : `gm:${user.name} didn't roll`;
    }
    if (!res) {
        const r = await actor.rollSave(type, { skipUI: true, chatMessage: !!actor.hasPlayerOwner });
        if (!r?.roll) return null;
        res = { d20: naturalD20(r.roll), total: r.roll.total, formula: r.roll.formula };
    }
    return { ...res, by };
}

/**
 * Player side (socketlib target): ask the owner to roll. Resolves with the result, or null if
 * they choose "GM rolls", close it, or time out.
 */
export async function promptSave({ actorUuid, type, itemName, casterName, timeout = 30000 }) {
    const actor = await fromUuid(actorUuid);
    if (!actor?.isOwner) return null;
    const label = SAVE_LABEL[type] ?? type;
    const secs = Math.round(timeout / 1000);
    const DialogV2 = foundry.applications.api.DialogV2;
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
        };
        const dlg = new DialogV2({
            window: { title: `${label} save`, icon: "fa-solid fa-shield-halved" },
            classes: ["sca-save-prompt"],
            position: { width: 360 },
            content: `<p><b>${esc(actor.name)}</b>: roll a <b>${esc(label)}</b> save against <b>${esc(itemName)}</b>${casterName ? ` from ${esc(casterName)}` : ""}.</p>
                <p class="sca-hint">Shift-click to open the roll dialog. If you don't roll within ${secs} seconds, the GM rolls it for you.</p>`,
            buttons: [
                {
                    action: "roll", label: `Roll ${label}`, icon: "fa-solid fa-dice-d20", default: true,
                    callback: async (event) => {
                        clearTimeout(timer);
                        const r = await actor.rollSave(type, { event });
                        finish(r?.roll ? { d20: naturalD20(r.roll), total: r.roll.total, formula: r.roll.formula } : null);
                    }
                },
                { action: "gm", label: "GM rolls", callback: () => finish(null) }
            ],
            rejectClose: false
        });
        dlg.addEventListener?.("close", () => finish(null));
        timer = setTimeout(() => {
            finish(null);
            dlg.close();
        }, timeout);
        dlg.render({ force: true });
    });
}
