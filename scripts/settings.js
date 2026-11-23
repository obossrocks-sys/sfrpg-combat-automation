import { MODULE_ID } from "./constants.js";

export function registerSettings() {
    const reg = (key, data) => {
        if (game.settings.settings.has(`${MODULE_ID}.${key}`)) return;
        game.settings.register(MODULE_ID, key, data);
    };

    reg("enabled", {
        name: "Automate targeted attacks",
        hint: "When an attack is rolled with tokens targeted, call hit or miss per target, roll damage on a hit and apply it on the GM's client.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("autoRollDamage", {
        name: "Roll damage on a hit",
        hint: "Roll the weapon's damage automatically when at least one target is hit.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("autoApply", {
        name: "Apply damage automatically",
        hint: "Apply damage to the targets as soon as it is rolled (Undo stays on the card). Off: the GM card offers an Apply button instead.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("applyConditions", {
        name: "Conditions from failed saves",
        hint: "A failed save against a grenade, explode weapon, spell or ability gives the conditions in its data (a grenade's effect line, a spell's condition links) for their duration. The module removes them when the time is up; conditions set by hand are never touched.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("critEffects", {
        name: "Critical hit effects",
        hint: "On a critical hit, roll the weapon's critical effect (CRB 182, Armory 26): conditions with their saves, burn, bleed and corrode, arc and pulse damage; the rest is shown to the GM with its DC.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("ongoingDamage", {
        name: "Burning, bleeding and corrode each turn",
        hint: "Deal ongoing damage at the start of the creature's turn; burning and corrode get a Reflex save at the end of its turn (DC 10 + that round's damage); bleeding stops once the creature is healed.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("ammo", {
        name: "Ammunition and limited uses",
        hint: "Stop attacks with an empty weapon (Ctrl-click still attacks); thrown grenades leave the inventory and the next one is drawn; automatic mode spends two shots per creature, nearest first, and uses the rest; abilities with limited uses spend one when used.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("npcAmmo", {
        name: "NPC ammunition",
        hint: "Arm NPCs when their tokens are placed: each weapon gets its ammunition type back from the compendium and a full battery or magazine loaded; spares are the stat block's ammunition (or 2 loads for small arms, longarms and sniper weapons, 1 for others) as real items to loot. Their ammunition is then tracked like the players' (needs Ammunition and limited uses on); an empty NPC weapon asks the GM whether to reload, a move action.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("zeroHpConditions", {
        name: "Conditions at 0 HP",
        hint: "NPCs die (or fall unconscious from nonlethal) and are marked defeated; PCs become dying and unconscious (or unconscious and stable from nonlethal).",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("hideSystemHitTag", {
        name: "Hide the system's AC tag for players",
        hint: "sfrpg prints \"vs KAC 18: HIT\" on the attack roll for the first target. The module's card replaces it, so the tag (and the AC in it) is removed when the module handles the attack.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("hidePublicOnGM", {
        name: "GM sees only the GM card",
        hint: "Hide the public card (Hit, Miss or Crit and the damage dealt) on GM screens, since the GM card already shows it. Players still get the public card.",
        scope: "world", config: true, type: Boolean, default: true,
        onChange: () => applyGmView()
    });
    reg("clearTargets", {
        name: "Clear targets after each attack",
        hint: "Off: targets stay until the player changes them.",
        scope: "world", config: true, type: Boolean, default: false
    });
    reg("removeDead", {
        name: "Remove the dead from the combat tracker",
        hint: "When a creature is marked dead (an NPC killed at 0 HP, or anyone given the Dead condition), delete its combatant and show the large dead icon on its token. Unconscious and dying creatures stay. Undo on the GM card puts the combatant back.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("gmCover", {
        scope: "world", config: false, type: String, default: "none",
        onChange: () => game.modules.get(MODULE_ID)?.api?.bar?.render?.()
    });
    reg("rangePenalties", {
        name: "Range penalties",
        hint: "-2 per full range increment past the first (-1 with Far Shot); attacks past maximum range miss.",
        scope: "world", config: true, type: Boolean, default: true
    });
    // Layer 2: saves and areas
    reg("automateSaves", {
        name: "Automate saves",
        hint: "When damage is rolled for a spell or ability with a save and tokens are targeted, roll each target's save and apply full, half or no damage. Explode weapons (grenades) aim at an intersection (AC 5), scatter on a miss, then everyone in the burst saves Reflex for half.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("areaAttacks", {
        name: "Area attack weapons",
        hint: "Blast, line and automatic-mode weapons attack every creature in their cone or line, each by its own rule (CRB 180-181). The cone or line is placed when you attack, unless you placed it from the item card first.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("templateTargets", {
        name: "Templates target tokens",
        hint: "Placing an area template from an item card targets every token in the squares it highlights (on the placer's screen). Shift-click tokens to adjust before rolling.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("playerSaves", {
        name: "Player saves",
        hint: "Who rolls a PC's save. Players: a prompt opens on the owner's screen; if they're offline or don't answer in time, the GM's client rolls it.",
        scope: "world", config: true, type: String, default: "player",
        choices: { player: "The player rolls (prompt)", gm: "The GM's client rolls every save" }
    });
    reg("saveTimeout", {
        name: "Save prompt timeout (seconds)",
        scope: "world", config: true, type: Number, default: 30,
        range: { min: 5, max: 120, step: 5 }
    });
    reg("spellResistance", {
        name: "Spell resistance checks",
        hint: "For spells that allow SR, roll d20 + caster level against each target's SR; a failed check means no effect.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("damageOnly", {
        name: "Damage-only effects hit targets",
        hint: "Damage rolled for an item with no attack and no save (for example magic missile) is applied in full to the targeted tokens.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("hideDCs", {
        name: "Hide save DCs from players",
        hint: "Module cards show only Saved or Failed, and DCs are removed from NPC item cards and roll titles before they're posted.",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("showBar", {
        name: "Show the attack-options bar",
        scope: "client", config: true, type: Boolean, default: true,
        onChange: () => game.modules.get(MODULE_ID)?.api?.bar?.render?.()
    });
    reg("barState", {
        scope: "client", config: false, type: Object, default: {}
    });
}

export const getSetting = (key) => game.settings.get(MODULE_ID, key);

/** Hide or show the public cards on this screen (GMs only, per the setting). */
export function applyGmView() {
    let hide = false;
    try {
        hide = !!game.user?.isGM && !!getSetting("hidePublicOnGM");
    } catch { /* settings not ready */ }
    document.body.classList.toggle("sca-hide-public", hide);
}
