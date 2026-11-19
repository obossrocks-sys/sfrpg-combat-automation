/**
 * Two messages per attack: a public card (hit, miss or crit and the damage dealt) and a
 * GM-only whisper with the numbers and the buttons. Players never receive the whisper,
 * so the numbers can't be read with Inspect Element.
 */
import { MODULE_ID, RESULT, RESULT_LABEL, ATTACK_OPTIONS, COVER } from "./constants.js";
import { AC_LABEL } from "./rules.js";
import { gmAction } from "./apply.js";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

function resultClass(r) {
    if (r === RESULT.CRIT) return "crit";
    if (r === RESULT.HIT) return "hit";
    if (r === RESULT.MANUAL) return "manual";
    return "miss";
}

function speaker(wf) {
    const a = wf.attacker;
    return { scene: a.sceneId, token: a.tokenId, actor: a.actorId, alias: a.name };
}

function header(wf, gm) {
    const opts = (wf.options ?? []).map(k => ATTACK_OPTIONS[k]?.short).filter(Boolean);
    if (wf.nonlethal && !wf.options?.includes("nonlethal")) opts.push("Nonlethal");
    if (wf.cover && wf.cover !== "none") opts.push(`${COVER[wf.cover]?.short} cover`);
    return `<header class="sca-head">
        <img src="${esc(wf.item.img)}" alt="">
        <div class="sca-title-wrap">
            <div class="sca-title">${esc(wf.item.name)}</div>
            <div class="sca-sub">${esc(wf.attacker.name)}${opts.length ? ` · ${esc(opts.join(", "))}` : ""}</div>
        </div>
        ${gm ? `<span class="sca-gm-badge">GM</span>` : ""}
    </header>`;
}

function publicRow(t, undone) {
    const ap = t.applied;
    const res = RESULT_LABEL[t.result] ?? t.result;
    let dmg = "";
    if (ap && !undone) dmg = `<span class="sca-dmg">${ap.dealt} damage</span>`;
    const status = ap?.status && !undone ? `<span class="sca-status">${esc(ap.status)}</span>` : "";
    return `<li class="sca-row sca-${resultClass(t.result)}">
        <img src="${esc(t.img)}" alt="">
        <span class="sca-name">${esc(t.name)}</span>
        <span class="sca-res">${esc(res)}</span>${dmg}${status}
    </li>`;
}

export function publicContent(wf) {
    return `<div class="sca-card${wf.undone ? " sca-undone" : ""}">
        ${header(wf, false)}
        <ul class="sca-targets">${wf.targets.map(t => publicRow(t, wf.undone)).join("")}</ul>
        ${wf.undone ? `<footer class="sca-foot">Undone by the GM</footer>` : ""}
    </div>`;
}

function gmRow(t, i, wf) {
    const ap = t.applied;
    const res = RESULT_LABEL[t.result] ?? t.result;
    const ac = AC_LABEL[t.acKey] ?? t.acKey;
    let roll = "";
    if (t.baseAc != null) {
        const acParts = [`${ac} ${t.baseAc}`];
        if (t.coverBonus) acParts.push(`+${t.coverBonus} cover`);
        if (t.proneAdj) acParts.push(`${t.proneAdj > 0 ? "+" : ""}${t.proneAdj} prone`);
        const rollParts = [`${t.rollTotal}`];
        if (t.range?.penalty) rollParts.push(`${t.range.penalty} range`);
        if (t.helplessBonus) rollParts.push(`+${t.helplessBonus} helpless`);
        const effRoll = rollParts.length > 1 ? `${rollParts.join(" ")} = ${t.effTotal}` : `${t.rollTotal}`;
        const effAc = acParts.length > 1 ? `${acParts.join(" ")} = ${t.effAc}` : `${ac} ${t.baseAc}`;
        roll = `<div class="sca-line">d20 ${t.nat ?? "?"}: ${esc(effRoll)} vs ${esc(effAc)}</div>`;
    }
    const notes = [...(t.notes ?? [])];
    if (t.range) notes.push(`${t.range.distance} ft (increment ${t.range.increment} ft)`);
    if (t.flipped) notes.push("flipped by GM");
    if (t.note) notes.push(t.note);
    const noteLine = notes.length ? `<div class="sca-line sca-notes">${esc(notes.join(" · "))}</div>` : "";
    let dmg = "";
    if (ap) {
        const b = ap.before, a = ap.after;
        const pools = [];
        if (b.temp || a.temp) pools.push(`Temp ${b.temp}→${a.temp}`);
        if (b.spMax) pools.push(`SP ${b.sp}→${a.sp}`);
        pools.push(`HP ${b.hp}→${a.hp}`);
        dmg = `<div class="sca-line">${ap.math.map(esc).join("<br>")}</div>
            <div class="sca-line"><b>Dealt ${ap.dealt}</b> · ${esc(pools.join(" · "))}${ap.status ? ` · <b>${esc(ap.status)}</b>` : ""}</div>`;
    }
    const canApply = !ap && !wf.undone && (t.result === RESULT.HIT || t.result === RESULT.CRIT);
    const flipLabel = (t.result === RESULT.HIT || t.result === RESULT.CRIT) ? "Make miss" : "Make hit";
    return `<li class="sca-row sca-gm-row sca-${resultClass(t.result)}">
        <div class="sca-row-head">
            <img src="${esc(t.img)}" alt="">
            <span class="sca-name">${esc(t.name)}</span>
            <span class="sca-res">${esc(res)}</span>
            ${wf.undone ? "" : `<button type="button" class="sca-btn" data-sca-action="flip" data-sca-index="${i}">${flipLabel}</button>`}
            ${canApply ? `<button type="button" class="sca-btn" data-sca-action="apply" data-sca-index="${i}">Apply</button>` : ""}
        </div>
        ${roll}${noteLine}${dmg}
    </li>`;
}

export function gmContent(wf) {
    const sections = (k) => (wf.damage?.[k] ?? []).map(s => `${s.total} (${s.formula})`).join(" + ");
    const dmgLine = [];
    if (wf.damage?.normal?.length) dmgLine.push(`Damage ${sections("normal")}`);
    if (wf.damage?.crit?.length) dmgLine.push(`Crit ${sections("crit")}`);
    return `<div class="sca-card sca-gm${wf.undone ? " sca-undone" : ""}">
        ${header(wf, true)}
        <div class="sca-line">Attack ${wf.attack.total} (d20 ${wf.attack.nat ?? "?"})${wf.nonlethal ? " · nonlethal" : ""}</div>
        ${dmgLine.length ? `<div class="sca-line">${esc(dmgLine.join(" · "))}</div>` : ""}
        <ul class="sca-targets">${wf.targets.map((t, i) => gmRow(t, i, wf)).join("")}</ul>
        <footer class="sca-foot">
            ${wf.undone
        ? `<span>Undone</span><button type="button" class="sca-btn" data-sca-action="redo">Reapply</button>`
        : `<button type="button" class="sca-btn" data-sca-action="undo">Undo</button>`}
        </footer>
    </div>`;
}

export async function createCards(wf) {
    const pub = await ChatMessage.create({
        speaker: speaker(wf),
        content: publicContent(wf),
        flags: { [MODULE_ID]: { public: true, workflowId: wf.workflowId } }
    });
    wf.publicMessageId = pub?.id ?? null;
    const gmIds = ChatMessage.getWhisperRecipients("GM").map(u => u.id);
    await ChatMessage.create({
        speaker: speaker(wf),
        content: gmContent(wf),
        whisper: gmIds,
        flags: { [MODULE_ID]: { gm: true, workflowId: wf.workflowId, workflow: wf } }
    });
}

export async function updateCards(gmMessage, wf) {
    await gmMessage.update({ content: gmContent(wf), [`flags.${MODULE_ID}.workflow`]: wf });
    const pub = game.messages.get(wf.publicMessageId);
    if (pub) await pub.update({ content: publicContent(wf) });
}

/** Hook: renderChatMessageHTML. Wire the GM card's buttons; hide them from anyone else. */
export function onRenderChatMessage(message, html) {
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!el) return;
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.gm) return;
    if (!game.user.isGM) {
        el.querySelectorAll("[data-sca-action]").forEach(b => b.remove());
        return;
    }
    el.querySelectorAll("[data-sca-action]").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const card = btn.closest(".sca-card");
            card?.classList.add("sca-busy");
            try {
                const idx = btn.dataset.scaIndex != null ? Number(btn.dataset.scaIndex) : null;
                await gmAction(message, btn.dataset.scaAction, idx);
            } catch (err) {
                console.error(`${MODULE_ID} |`, err);
                ui.notifications.error(`Combat automation: ${err.message ?? err}`);
            } finally {
                card?.classList.remove("sca-busy");
            }
        });
    });
}
