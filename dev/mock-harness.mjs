/**
 * A rough stand-in for Foundry and sfrpg, enough to run the GM-side flows (apply.js, saves.js,
 * cards.js) in Node and catch runtime errors before testing in the game. Not a substitute for the
 * Test Range. Run: node dev/mock-harness.mjs
 */
import assert from "node:assert/strict";

const MOD = "sfrpg-combat-automation";
const settings = {
    enabled: true, autoRollDamage: true, autoApply: true, zeroHpConditions: true, hideSystemHitTag: true,
    hidePublicOnGM: true, clearTargets: true, rangePenalties: true, automateSaves: true, areaAttacks: true,
    templateTargets: true, playerSaves: "player", saveTimeout: 5, spellResistance: true, damageOnly: true, hideDCs: true
};

// Dice: a queue of forced d20 results, else 10.
const forced = [];
const nextD20 = () => (forced.length ? forced.shift() : 10);

class Roll {
    constructor(formula) {
        this.formula = formula;
    }
    async evaluate() {
        const m = this.formula.match(/1d20\s*\+\s*(-?\d+)/);
        const d = nextD20();
        this.total = d + (m ? Number(m[1]) : 0);
        this.dice = [{ faces: 20, total: d, results: [{ result: d, active: true }] }];
        return this;
    }
}

const messages = new Map();
let msgId = 0;
class ChatMessageMock {
    constructor(data) {
        Object.assign(this, data);
        this.id = `m${++msgId}`;
        this.flags = data.flags ?? {};
    }
    static async create(data) {
        const m = new ChatMessageMock(data);
        messages.set(m.id, m);
        return m;
    }
    static getWhisperRecipients() {
        return [{ id: "gm" }];
    }
    async update(u) {
        for (const [k, v] of Object.entries(u)) {
            if (k.startsWith("flags.")) {
                const path = k.split(".").slice(1);
                let o = this.flags;
                for (const p of path.slice(0, -1)) o = (o[p] ??= {});
                o[path.at(-1)] = v;
            } else this[k] = v;
        }
        return this;
    }
}

function setPath(obj, path, v) {
    const parts = path.split(".");
    let o = obj;
    for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
    o[parts.at(-1)] = v;
}

class ActorMock {
    constructor({ name, type = "npc2", hp = 40, sp = 0, saves = {}, dr = 0, er = {}, immune = [], items = [], player = false, sr = 0 }) {
        this.name = name;
        this.type = type;
        this.uuid = `Actor.${name}`;
        this.id = name;
        this.system = {
            attributes: { hp: { value: hp, max: hp, temp: 0, tempmax: 0 }, sp: { value: sp, max: sp } },
            traits: { sr },
            details: { cl: { value: 7 } }
        };
        this.saves = saves;
        this.dr = dr;
        this.er = er;
        this.immune = immune;
        this.items = items.map(n => (typeof n === "string" ? { name: n, type: "feat" } : n));
        this.hasPlayerOwner = player;
        this.conditions = new Set();
        this.statuses = new Set();
        this.isOwner = true;
    }
    isImmuneToDamageType(t) { return this.immune.includes(t); }
    isVulnerableToDamageType() { return false; }
    getDamageMitigationForDamageType(t) {
        if (["bludgeoning", "piercing", "slashing"].includes(t)) return this.dr;
        return this.er[t] ?? 0;
    }
    async applyDamage(dmg) {
        let remaining = 0;
        const share = dmg.amount / Math.max(1, dmg.damageTypes.length);
        for (const t of dmg.damageTypes.length ? dmg.damageTypes : ["untyped"]) {
            if (this.isImmuneToDamageType(t)) continue;
            remaining += Math.max(0, share - this.getDamageMitigationForDamageType(t));
        }
        remaining = Math.floor(remaining);
        const a = this.system.attributes;
        const fromSp = Math.min(a.sp.value, remaining);
        a.sp.value -= fromSp;
        a.hp.value = Math.max(0, a.hp.value - (remaining - fromSp));
    }
    async rollSave(type, opts) {
        const d = nextD20();
        const bonus = this.saves[type] ?? 0;
        this.lastSaveChat = opts.chatMessage;
        return { roll: { total: d + bonus, formula: `1d20 + ${bonus}`, dice: [{ faces: 20, results: [{ result: d, active: true }] }] } };
    }
    hasCondition(n) { return this.conditions.has(n); }
    getCondition(n) { return this.conditions.has(n); }
    async setCondition(n, on) { on ? this.conditions.add(n) : this.conditions.delete(n); }
    async toggleStatusEffect(id, { active }) { active ? this.statuses.add(id) : this.statuses.delete(id); }
    async update(u) { for (const [k, v] of Object.entries(u)) setPath(this, k, v); return this; }
    testUserPermission() { return this.hasPlayerOwner; }
}

const docs = new Map();
function token(actor) {
    const doc = { uuid: `Scene.s.Token.${actor.name}`, id: actor.name, parent: { id: "s" }, actor, name: actor.name, texture: { src: "x.png" } };
    docs.set(doc.uuid, doc);
    docs.set(actor.uuid, actor);
    return doc;
}

globalThis.Roll = Roll;
globalThis.ChatMessage = ChatMessageMock;
globalThis.fromUuid = async (u) => docs.get(u) ?? null;
globalThis.CONFIG = {
    specialStatusEffects: { DEFEATED: "dead" },
    SFRPG: { statusEffects: ["helpless", "paralyzed", "pinned", "unconscious", "stunned", "encumbered", "overburdened", "prone", "dying", "stable"].map(id => ({ id })) }
};
globalThis.foundry = {
    utils: {
        escapeHTML: (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
        deepClone: (o) => structuredClone(o),
        randomID: () => Math.random().toString(36).slice(2, 10)
    }
};
const users = [{ id: "gm", isGM: true, active: true, name: "Owen" }];
users.filter = Array.prototype.filter;
globalThis.game = {
    user: users[0],
    users,
    settings: { get: (mod, key) => settings[key] },
    modules: { get: () => null },
    messages: { get: (id) => messages.get(id) },
    combats: [],
    sfrpg: { Actor: { Damage: { SFRPGDamage: { createDamage: (amount, damageTypes) => ({ amount, damageTypes }) } } } }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

const { processSave, processAttack, gmAction } = await import("../scripts/apply.js");
const { publicContent } = await import("../scripts/cards.js");

const plain = (h) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const gmCard = () => [...messages.values()].filter(m => m.flags?.[MOD]?.gm).pop();
const settle = () => new Promise(r => setTimeout(r, 50));
let passed = 0;
const check = async (name, fn) => {
    try {
        await fn();
        passed++;
    } catch (err) {
        console.error(`FAIL ${name}\n  ${err.stack?.split("\n").slice(0, 3).join("\n  ")}`);
        process.exitCode = 1;
    }
};

const base = (over) => ({
    workflowId: Math.random().toString(36).slice(2),
    userId: "gm",
    attacker: { actorUuid: "Actor.Caster", name: "Caster", img: "c.png", sceneId: "s" },
    item: { uuid: "Item.x", name: "Explosive Blast (DC 16)", publicName: "Explosive Blast", img: "i.png", hasDamage: true, allowsSR: false },
    cover: "none", options: [], nonlethal: false, properties: [],
    ...over
});
docs.set("Actor.Caster", new ActorMock({ name: "Caster" }));

await check("area save: fail full, save half, evasion zero", async () => {
    const a = new ActorMock({ name: "Grunt", hp: 40, saves: { reflex: 2 } });
    const b = new ActorMock({ name: "Tough", hp: 40, saves: { reflex: 10 } });
    const c = new ActorMock({ name: "Slippery", hp: 40, saves: { reflex: 10 }, items: ["Evasion (Ex) (Operative)"] });
    const wf = base({
        kind: "save",
        save: { type: "reflex", label: "Reflex", dc: 16, base: null, parts: [], onSave: "half", flagged: false, note: "" },
        targets: [a, b, c].map(x => ({ ...token(x), tokenUuid: `Scene.s.Token.${x.name}`, actorUuid: x.uuid, img: "x.png", notes: [] })),
        damage: { normal: [{ total: 17, formula: "5d6", types: ["fire"], operator: "and" }], crit: [] }
    });
    forced.push(5, 10, 10); // Grunt 7 fails; Tough 20 saves; Slippery 20 saves
    await processSave(wf);
    await settle();
    assert.equal(a.system.attributes.hp.value, 23);
    assert.equal(b.system.attributes.hp.value, 32);
    assert.equal(c.system.attributes.hp.value, 40);
    const txt = plain(gmCard().content);
    assert.match(txt, /Reflex DC 16/);
    assert.match(txt, /Evasion: no damage/);
    const pub = plain(publicContent(gmCard().flags[MOD].workflow));
    assert.doesNotMatch(pub, /DC|16\)/);
    assert.match(pub, /Saved: Evasion/);
});

await check("flip a save and set a share", async () => {
    const msg = gmCard();
    await gmAction(msg, "flipsave", 1); // Tough: saved -> failed
    let wf = msg.flags[MOD].workflow;
    assert.equal(wf.targets[1].result, "failed");
    assert.equal(wf.targets[1].applied.dealt, 17);
    await gmAction(msg, "share", 0, "none");
    wf = msg.flags[MOD].workflow;
    assert.equal(wf.targets[0].applied, null);
    await gmAction(msg, "undo");
    wf = msg.flags[MOD].workflow;
    assert.equal(wf.undone, true);
    await gmAction(msg, "redo");
});

await check("partial flagged, negate none, SR resisted, PC rolled by GM in chat", async () => {
    const npc = new ActorMock({ name: "Negator", hp: 30, saves: { will: 10 }, sr: 30 });
    const pc = new ActorMock({ name: "Hero", type: "character", hp: 20, sp: 10, saves: { will: 10 }, player: true });
    const wf = base({
        kind: "save",
        item: { uuid: "Item.y", name: "Mind Thrust", publicName: "Mind Thrust", img: "i.png", hasDamage: true, allowsSR: true },
        save: { type: "will", label: "Will", dc: 15, base: null, parts: [], onSave: "half", flagged: true, note: "partial: check the effect" },
        targets: [npc, pc].map(x => ({ tokenUuid: token(x).uuid, actorUuid: x.uuid, name: x.name, img: "x.png", notes: [] })),
        damage: { normal: [{ total: 12, formula: "2d10", types: [], operator: "and" }], crit: [] }
    });
    forced.push(3, 10); // SR check 3+7=10 < 30 resisted; Hero's save 20 saves
    await processSave(wf);
    await settle();
    const w = gmCard().flags[MOD].workflow;
    assert.equal(w.targets[0].result, "resisted");
    assert.equal(npc.system.attributes.hp.value, 30);
    assert.equal(w.targets[1].result, "saved");
    assert.equal(w.targets[1].flagged, true);
    assert.equal(pc.system.attributes.sp.value, 4); // half of 12 = 6 from SP
    assert.equal(pc.lastSaveChat, true); // no player online: GM rolls it into chat
});

await check("explode crit on the nearest, DC with range", async () => {
    const near = new ActorMock({ name: "Near", hp: 50, saves: { reflex: 0 } });
    const far = new ActorMock({ name: "Far", hp: 50, saves: { reflex: 0 } });
    const wf = base({
        kind: "explode",
        item: { uuid: "Item.g", name: "Frag grenade I", publicName: "Frag grenade I", img: "g.png", hasDamage: true, allowsSR: false },
        attack: { total: 25, nat: 20, eff: 23, penalty: -2, distance: 30, hit: true, notes: [] },
        scatter: null,
        save: { type: "reflex", label: "Reflex", dc: 12, base: 14, parts: [{ label: "range", value: -2 }], onSave: "half", flagged: false, note: "" },
        targets: [
            { tokenUuid: token(near).uuid, actorUuid: near.uuid, name: "Near", img: "x", notes: [], critTarget: true },
            { tokenUuid: token(far).uuid, actorUuid: far.uuid, name: "Far", img: "x", notes: [], critTarget: false }
        ],
        damage: { normal: [{ total: 4, formula: "1d6", types: ["piercing"], operator: "and" }], crit: [{ total: 9, formula: "1d6+1d6", types: ["piercing"], operator: "and" }] }
    });
    forced.push(2, 2); // both fail
    await processSave(wf);
    await settle();
    assert.equal(near.system.attributes.hp.value, 41);
    assert.equal(far.system.attributes.hp.value, 46);
    assert.match(plain(gmCard().content), /Reflex DC 14 -2 range _?=? ?12|Reflex DC 14 -2 range = 12/);
    assert.match(plain(publicContent(gmCard().flags[MOD].workflow)), /On target/);
});

await check("explode scatter text and empty burst", async () => {
    const wf = base({
        kind: "explode",
        item: { uuid: "Item.g", name: "Frag grenade I", img: "g.png", hasDamage: true },
        attack: { total: 3, nat: 3, eff: 3, penalty: 0, distance: 10, hit: false, notes: [] },
        scatter: { d8: 3, d4: 2, eighth: 4, squares: 2 },
        save: { type: "reflex", label: "Reflex", dc: 14, base: 14, parts: [], onSave: "half", flagged: false, note: "" },
        targets: [], damage: { normal: [], crit: [] }
    });
    await processSave(wf);
    await settle();
    assert.match(plain(publicContent(gmCard().flags[MOD].workflow)), /landed 2 squares west/);
    assert.match(plain(gmCard().content), /No one in the area/);
});

await check("line stops at the first creature that takes no damage", async () => {
    const t1 = new ActorMock({ name: "L1", hp: 30 });
    const t2 = new ActorMock({ name: "L2", hp: 30, dr: 10 });
    const t3 = new ActorMock({ name: "L3", hp: 30 });
    const wf = base({
        kind: "line",
        item: { uuid: "Item.l", name: "Flame pistol", img: "l.png", hasDamage: true },
        attack: { total: 20, nat: 15, formula: "1d20+5", acKey: "kac", penalty: 0 },
        targets: [t1, t2, t3].map(x => ({ tokenUuid: token(x).uuid, actorUuid: x.uuid, name: x.name, img: "x", result: "hit", notes: [], acKey: "kac", baseAc: 15, rollTotal: 20, effTotal: 20, effAc: 15, nat: 15 })),
        damage: { normal: [{ total: 8, formula: "2d4", types: ["piercing"], operator: "and" }], crit: [] }
    });
    await processAttack(wf);
    assert.equal(t1.system.attributes.hp.value, 22);
    assert.equal(t2.system.attributes.hp.value, 30);
    assert.equal(t3.system.attributes.hp.value, 30);
    assert.match(plain(gmCard().content), /line stopped/);
    assert.match(plain(publicContent(gmCard().flags[MOD].workflow)), /Line stopped/);
});

await check("rider save halves on a save", async () => {
    const r = new ActorMock({ name: "Rider", hp: 30, saves: { fort: 10 } });
    const wf = base({
        kind: "attack",
        item: { uuid: "Item.r", name: "Disintegrating Touch", img: "r.png", hasDamage: true },
        attack: { total: 20, nat: 15, formula: "1d20+5", acKey: "eac" },
        rider: { type: "fort", label: "Fortitude", dc: 19, onSave: "half", descriptor: "half" },
        targets: [{ tokenUuid: token(r).uuid, actorUuid: r.uuid, name: "Rider", img: "x", result: "hit", notes: [], acKey: "eac", baseAc: 15, rollTotal: 20, effTotal: 20, effAc: 15, nat: 15 }],
        damage: { normal: [{ total: 21, formula: "6d6", types: [], operator: "and" }], crit: [] }
    });
    forced.push(12); // 22 vs 19 saves
    await processAttack(wf);
    await settle();
    assert.equal(r.system.attributes.hp.value, 20); // half of 21 = 10
    assert.match(plain(gmCard().content), /Fortitude d20 12 \+10 _?=? ?22|Fortitude d20 12 \+10 = 22/);
});

await check("drone inactive at 0, destroyed by a big hit at 0", async () => {
    const d = new ActorMock({ name: "Drone", type: "drone", hp: 10 });
    const wf = base({
        kind: "damage",
        save: null,
        targets: [{ tokenUuid: token(d).uuid, actorUuid: d.uuid, name: "Drone", img: "x", notes: [] }],
        damage: { normal: [{ total: 12, formula: "2d6", types: [], operator: "and" }], crit: [] }
    });
    await processSave(wf);
    await settle();
    assert.equal(d.conditions.has("unconscious"), true);
    assert.match(plain(gmCard().content), /Inactive/);
    const wf2 = base({ ...wf, workflowId: "w2" });
    await processSave(wf2);
    await settle();
    assert.equal(d.statuses.has("dead"), true);
    assert.match(plain(gmCard().content), /Destroyed/);
});

await check("improved evasion lost in heavy armor", async () => {
    const pc = new ActorMock({ name: "Tank", type: "character", hp: 30, saves: { reflex: 0 }, items: ["Improved Evasion (Ex)", { name: "Heavy plate", type: "equipment", system: { equipped: true, armor: { type: "heavy" } } }] });
    const wf = base({
        kind: "save",
        save: { type: "reflex", label: "Reflex", dc: 15, base: null, parts: [], onSave: "half", flagged: false, note: "" },
        targets: [{ tokenUuid: token(pc).uuid, actorUuid: pc.uuid, name: "Tank", img: "x", notes: [] }],
        damage: { normal: [{ total: 10, formula: "3d6", types: [], operator: "and" }], crit: [] }
    });
    forced.push(2);
    await processSave(wf);
    await settle();
    assert.equal(pc.system.attributes.hp.value, 20);
    assert.match(plain(gmCard().content), /Improved Evasion doesn't apply \(Heavy plate\)/);
});

console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
