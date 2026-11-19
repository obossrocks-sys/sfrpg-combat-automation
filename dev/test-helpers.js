/**
 * Prototype helpers for the Test Range scene (not part of the module).
 * Load in the GM's console:
 *   const sha = "<commit>"; await import(`https://cdn.jsdelivr.net/gh/obossrocks-sys/sfrpg-combat-automation@${sha}/dev/test-helpers.js`); await SCA_LOAD(sha);
 */
const REPO = "https://cdn.jsdelivr.net/gh/obossrocks-sys/sfrpg-combat-automation";

/** Load the module from a commit (CSS + scripts). Replaces any copy already loaded. */
window.SCA_LOAD = async (sha) => {
    const base = `${REPO}@${sha}`;
    document.getElementById("sca-css")?.remove();
    const l = document.createElement("link");
    l.id = "sca-css";
    l.rel = "stylesheet";
    l.href = `${base}/styles/sca.css`;
    document.head.appendChild(l);
    await import(`${base}/scripts/main.js`);
    return `loaded ${sha.slice(0, 7)}`;
};

/** Force dice: numbers >= 1 are faces, fractions are a share of the faces. */
const Die = foundry.dice.terms.Die;
window.SCA_FORCE = (seq) => {
    let i = 0;
    Die.prototype._roll = async function () {
        const v = seq[Math.min(i++, seq.length - 1)];
        return Math.min(this.faces, Math.max(1, v < 1 ? Math.ceil(v * this.faces) : v));
    };
};
window.SCA_UNFORCE = () => { delete Die.prototype._roll; };

const tok = (n) => canvas.tokens.placeables.find(t => t.name === n);
window.SCA_TOK = tok;

const text = (html) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
window.SCA_TEXT = text;

/** Attack from a named token with an item (name prefix) at named targets. */
window.SCA_ATTACK = async (attacker, itemStart, targets, opts = {}) => {
    canvas.tokens.releaseAll();
    tok(attacker).control({ releaseOthers: true });
    canvas.tokens.setTargets(targets.map(n => tok(n).id), { mode: "replace" });
    const item = tok(attacker).actor.items.find(i => i.name.startsWith(itemStart));
    if (opts.seq) SCA_FORCE(opts.seq);
    try {
        await item.rollAttack({ event: { ctrlKey: true } });
        await new Promise(r => setTimeout(r, opts.wait ?? 3000));
    } finally {
        SCA_UNFORCE();
    }
    const gm = game.messages.contents.filter(m => m.flags?.["sfrpg-combat-automation"]?.gm).pop();
    return text(gm?.content).replace(/Make (miss|hit)|Undo$/g, "").replace(/[=&?<>]/g, "_");
};

/** Click a button on the newest GM card (action: undo, redo, flip, apply). */
window.SCA_CLICK = async (action, index = null) => {
    const msg = game.messages.contents.filter(m => m.flags?.["sfrpg-combat-automation"]?.gm).pop();
    const sel = `[data-sca-action="${action}"]` + (index != null ? `[data-sca-index="${index}"]` : "");
    const btn = document.querySelector(`#chat [data-message-id="${msg.id}"] ${sel}`)
        ?? document.querySelector(`[data-message-id="${msg.id}"] ${sel}`);
    if (!btn) return "no button";
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    const m2 = game.messages.get(msg.id);
    return text(m2.content).replace(/[=&?<>]/g, "_");
};

/** Current HP, SP, temp and conditions of the test tokens. */
window.SCA_STATE = (names) => (names ?? canvas.tokens.placeables.map(t => t.name)).map(n => {
    const a = tok(n).actor;
    const at = a.system.attributes;
    const conds = ["dying", "unconscious", "stable", "prone", "flat-footed"].filter(c => a.hasCondition(c));
    if (a.statuses?.has("dead")) conds.push("DEAD");
    return `${n}: hp${at.hp.value} sp${at.sp?.value ?? "-"} t${at.hp.temp ?? 0} ${conds.join("+")}`;
}).join(" | ");

/** Put every test token back to full and clear conditions. */
window.SCA_RESET = async () => {
    for (const t of canvas.tokens.placeables) {
        const a = t.actor;
        const at = a.system.attributes;
        for (const c of ["dying", "unconscious", "stable", "dead", "prone", "flat-footed", "helpless"]) {
            if (a.hasCondition(c)) await a.setCondition(c, false);
        }
        if (a.statuses?.has("dead")) await a.toggleStatusEffect("dead", { overlay: true, active: false });
        const up = { "system.attributes.hp.value": at.hp.max };
        if (at.sp?.max) up["system.attributes.sp.value"] = at.sp.max;
        if (a.name === "Test Crypto") {
            up["system.attributes.hp.temp"] = 5;
            up["system.attributes.hp.tempmax"] = 5;
        }
        await a.update(up);
    }
    for (const c of game.combats) for (const cb of c.combatants) if (cb.defeated) await cb.update({ defeated: false });
};

/** Delete every chat message spoken by a Module Test actor. */
window.SCA_CLEAN_CHAT = async () => {
    const folder = game.folders.find(f => f.type === "Actor" && f.name === "Module Test");
    const ids = new Set(folder?.contents.map(a => a.id) ?? []);
    const del = game.messages.filter(m => ids.has(m.speaker?.actor)).map(m => m.id);
    await ChatMessage.deleteDocuments(del);
    return del.length;
};
