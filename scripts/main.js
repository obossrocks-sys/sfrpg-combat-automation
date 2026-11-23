import { MODULE_ID } from "./constants.js";
import { registerSettings, applyGmView } from "./settings.js";
import { setupSocket, registerHandler } from "./socket.js";
import { onAttackRolled, onDamageRolled, onPreCreateChatMessage, wrapRollDamage } from "./workflow.js";
import { processAttack, processSave, onDeadStatus } from "./apply.js";
import { onCombatTurn, onCombatEnd, onWorldTime } from "./conditions.js";
import * as effects from "./effects.js";
import { promptSave } from "./saves.js";
import { onRenderChatMessage } from "./cards.js";
import { wrapPlaceAbilityTemplate, onPreCreateTemplate, onCreateTemplate, onPreCreateRegion, onCreateRegion, explodeArea } from "./areas.js";
import { bar } from "./options-bar.js";
import * as rules from "./rules.js";
import * as logic from "./logic.js";

const hookIds = [];
function on(name, fn) {
    hookIds.push([name, Hooks.on(name, fn)]);
}

/** Methods on sfrpg's classes the module wraps, so teardown can put them back. */
const patches = [];
function patch(proto, name, makeWrapper) {
    const original = proto?.[name];
    if (typeof original !== "function") {
        console.warn(`${MODULE_ID} | can't wrap ${name}: not found`);
        return;
    }
    const wrapper = makeWrapper(original);
    proto[name] = wrapper;
    patches.push({ proto, name, original, wrapper });
}

let started = false;

function start() {
    if (started) return;
    started = true;
    registerSettings();
    registerHandler("processAttack", processAttack);
    registerHandler("processSave", processSave);
    registerHandler("promptSave", promptSave);
    setupSocket();

    on("attackRolled", onAttackRolled);
    on("damageRolled", onDamageRolled);
    on("preCreateChatMessage", onPreCreateChatMessage);
    on("renderChatMessageHTML", onRenderChatMessage);
    on("preCreateMeasuredTemplate", onPreCreateTemplate);
    on("createMeasuredTemplate", onCreateTemplate);
    // Foundry v14 creates templates as Regions.
    on("preCreateRegion", onPreCreateRegion);
    on("createRegion", onCreateRegion);
    on("createActiveEffect", (effect) => { onDeadStatus(effect).catch(err => console.error(`${MODULE_ID} |`, err)); });
    on("updateCombat", (combat, changed) => {
        if ("turn" in changed || "round" in changed) bar.onTurnChange();
        onCombatTurn(combat, changed).catch(err => console.error(`${MODULE_ID} |`, err));
    });
    on("deleteCombat", (combat) => { onCombatEnd(combat).catch(err => console.error(`${MODULE_ID} |`, err)); });
    on("updateWorldTime", onWorldTime);

    const itemProto = CONFIG.Item.documentClass?.prototype;
    patch(itemProto, "rollDamage", wrapRollDamage);
    patch(itemProto, "placeAbilityTemplate", wrapPlaceAbilityTemplate);

    bar.load();
    bar.render();
    applyGmView();

    const api = { bar, rules, logic, effects, explodeArea, teardown, version: game.modules.get(MODULE_ID)?.version };
    globalThis.SFRPGCombatAutomation = api;
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = api;
    console.log(`${MODULE_ID} | ready`);
}

/** Remove hooks, wrappers and the bar (used when a dev copy is loaded over this one). */
export function teardown() {
    for (const [name, id] of hookIds.splice(0)) Hooks.off(name, id);
    for (const p of patches.splice(0).reverse()) {
        if (p.proto[p.name] === p.wrapper) p.proto[p.name] = p.original;
    }
    bar.close();
    document.body.classList.remove("sca-hide-public");
    started = false;
}

// Loading a dev copy in a running game: drop the copy already running first.
globalThis.SFRPGCombatAutomation?.teardown?.();

Hooks.once("init", registerSettings);
Hooks.once("socketlib.ready", setupSocket);
if (globalThis.game?.ready) start();
else Hooks.once("ready", start);
