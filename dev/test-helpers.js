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

/** Click a button on the newest GM card (action: undo, redo, flip, apply, flipsave, share with value full/half/none). */
window.SCA_CLICK = async (action, index = null, value = null) => {
    const msg = game.messages.contents.filter(m => m.flags?.["sfrpg-combat-automation"]?.gm).pop();
    const sel = `[data-sca-action="${action}"]` + (index != null ? `[data-sca-index="${index}"]` : "") + (value ? `[data-sca-value="${value}"]` : "");
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

/* ---------- layer 2 ---------- */

const MOD = "sfrpg-combat-automation";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gmCardText = () => {
    const gm = game.messages.contents.filter(m => m.flags?.[MOD]?.gm).pop();
    return text(gm?.content).replace(/Make (miss|hit|saved|failed)|Undo$/g, "").replace(/[=&?<>]/g, "_");
};
window.SCA_GM_CARD = gmCardText;

/**
 * Place an item's template as if from its card (flagged with the item, so the module targets what's
 * inside and the next roll uses it). col/row are scene squares; vertex true puts it on the square's
 * top-left corner (an intersection), false on its center. Shape and size come from the item unless given.
 */
window.SCA_TEMPLATE = async (ownerName, itemStart, { col, row, vertex = true, t = null, distance = null, direction = 0 } = {}) => {
    const token = tok(ownerName);
    const item = token.actor.items.find(i => i.name.startsWith(itemStart));
    const spec = SFRPGCombatAutomation.logic.areaSpec(item.system, { description: item.system?.description?.value ?? "" }) ?? {};
    const d = canvas.dimensions;
    const s = canvas.grid.size;
    const data = {
        t: t ?? spec.t ?? "circle",
        distance: distance ?? spec.distance ?? 10,
        direction,
        x: d.sceneX + col * s + (vertex ? 0 : s / 2),
        y: d.sceneY + row * s + (vertex ? 0 : s / 2),
        user: game.user.id,
        fillColor: game.user.color?.css ?? "#ff0000",
        flags: { [MOD]: { itemUuid: item.uuid, actorUuid: item.actor.uuid } }
    };
    if (data.t === "cone") data.angle = 90;
    if (data.t === "ray") data.width = d.distance;
    const [doc] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [data]);
    await sleep(800);
    return `${doc.id} ${data.t} ${data.distance}ft: targets ${[...game.user.targets].map(x => x.name).join(", ") || "none"}`;
};

/** Delete every template on the scene. */
window.SCA_CLEAR_TEMPLATES = async () => {
    const ids = canvas.scene.templates.map(t => t.id);
    await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", ids);
    return ids.length;
};

/** Roll damage for a save or damage-only item (as the card's Damage button does). Targets: names, or keep the template's. */
window.SCA_CAST = async (caster, itemStart, targets = null, opts = {}) => {
    canvas.tokens.releaseAll();
    tok(caster).control({ releaseOthers: true });
    if (targets) canvas.tokens.setTargets(targets.map(n => tok(n).id), { mode: "replace" });
    const item = tok(caster).actor.items.find(i => i.name.startsWith(itemStart));
    if (opts.seq) SCA_FORCE(opts.seq);
    try {
        await item.rollDamage({ event: { shiftKey: false } }, { skipUI: true });
    } finally {
        if (!opts.keepForce) SCA_UNFORCE();
    }
    await sleep(opts.wait ?? 3000);
    return gmCardText();
};

/** Attack with an area weapon (grenade, blast, line). Place its template first with SCA_TEMPLATE. */
window.SCA_THROW = async (attacker, itemStart, opts = {}) => {
    canvas.tokens.releaseAll();
    tok(attacker).control({ releaseOthers: true });
    const item = tok(attacker).actor.items.find(i => i.name.startsWith(itemStart));
    if (opts.auto) SFRPGCombatAutomation.bar.toggleAuto();
    if (opts.seq) SCA_FORCE(opts.seq);
    try {
        await item.rollAttack({ event: { ctrlKey: true } });
        await sleep(opts.wait ?? 3500);
    } finally {
        SCA_UNFORCE();
    }
    return gmCardText();
};

/** Item summary for planning tests: saves, areas and properties of an actor's items. */
window.SCA_ITEMS = (name) => tok(name).actor.items.filter(i => i.hasDamage || i.hasSave).map(i => {
    const p = Object.entries(i.system?.properties ?? {}).filter(([, v]) => v?.value).map(([k]) => k).join("/");
    const sv = i.system?.save?.type ? `${i.system.save.type}:${i.system.save.descriptor}:${i.labels?.dcValue}` : "";
    const ar = i.system?.area?.shape ? `${i.system.area.shape}${i.system.area.value}` : "";
    return `${i.name} [${i.type} ${i.system?.actionType ?? ""} ${p} ${sv} ${ar}]`;
}).join(" | ").replace(/[=&?<>]/g, "_");
