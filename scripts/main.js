import { MODULE_ID } from "./constants.js";
import { registerSettings, applyGmView } from "./settings.js";
import { setupSocket, registerHandler } from "./socket.js";
import { onAttackRolled, onDamageRolled, onPreCreateChatMessage } from "./workflow.js";
import { processAttack } from "./apply.js";
import { onRenderChatMessage } from "./cards.js";
import { bar } from "./options-bar.js";
import * as rules from "./rules.js";

const hookIds = [];
function on(name, fn) {
    hookIds.push([name, Hooks.on(name, fn)]);
}

let started = false;

function start() {
    if (started) return;
    started = true;
    registerSettings();
    registerHandler("processAttack", processAttack);
    setupSocket();

    on("attackRolled", onAttackRolled);
    on("damageRolled", onDamageRolled);
    on("preCreateChatMessage", onPreCreateChatMessage);
    on("renderChatMessageHTML", onRenderChatMessage);
    on("updateCombat", (combat, changed) => {
        if ("turn" in changed || "round" in changed) bar.onTurnChange();
    });

    bar.load();
    bar.render();
    applyGmView();

    const api = { bar, rules, teardown };
    globalThis.SFRPGCombatAutomation = api;
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = api;
    console.log(`${MODULE_ID} | ready`);
}

/** Remove hooks and the bar (used when the prototype is reloaded in place). */
export function teardown() {
    for (const [name, id] of hookIds.splice(0)) Hooks.off(name, id);
    bar.close();
    document.body.classList.remove("sca-hide-public");
    started = false;
}

// Reloading the prototype in a running game: drop the previous copy first.
globalThis.SFRPGCombatAutomation?.teardown?.();

Hooks.once("init", registerSettings);
Hooks.once("socketlib.ready", setupSocket);
if (globalThis.game?.ready) start();
else Hooks.once("ready", start);
