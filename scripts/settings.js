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
    reg("clearTargets", {
        name: "Clear targets after each attack",
        scope: "world", config: true, type: Boolean, default: true
    });
    reg("rangePenalties", {
        name: "Range penalties",
        hint: "-2 per full range increment past the first (-1 with Far Shot); attacks past maximum range miss.",
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
