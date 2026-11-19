import { MODULE_ID } from "./constants.js";

const handlers = new Map();
let socket = null;

/** Register with socketlib (called from the socketlib.ready hook, or late during the prototype). */
export function setupSocket() {
    if (socket || !globalThis.socketlib) return;
    try {
        socket = socketlib.registerModule(MODULE_ID);
        for (const [name, fn] of handlers) socket.register(name, fn);
    } catch (err) {
        // Module not installed as a module (prototype injection): GM-side calls run locally.
        console.warn(`${MODULE_ID} | socketlib registration unavailable; GM calls run locally only.`, err?.message ?? err);
        socket = null;
    }
}

export function registerHandler(name, fn) {
    handlers.set(name, fn);
    if (socket) socket.register(name, fn);
}

/** Run a handler on the GM's client (locally when this user is a GM). */
export async function executeAsGM(name, ...args) {
    const fn = handlers.get(name);
    if (game.user.isGM) return fn(...args);
    if (!socket) throw new Error("No socket: the module is not active for this user.");
    return socket.executeAsGM(name, ...args);
}
