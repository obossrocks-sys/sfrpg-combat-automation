/**
 * Two messages per workflow: a public card (hit, miss or crit, or saved or failed, and the damage
 * dealt) and a GM-only whisper with the numbers and the buttons. Players never receive the
 * whisper, so ACs and DCs can't be read with Inspect Element.
 */
import { MODULE_ID, RESULT, RESULT_LABEL, ATTACK_OPTIONS, COVER, KIND } from "./constants.js";
import { AC_LABEL } from "./rules.js";
import { gmAction } from "./apply.js";
import { SAVE_LABEL, compass } from "./logic.js";
import { effectSummary } from "./conditions.js";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const SAVE_KINDS = [KIND.SAVE, KIND.DAMAGE, KIND.EXPLODE];
const isSaveKind = (wf) => SAVE_KINDS.includes(wf.kind);
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

function resultClass(r) {
    switch (r) {
        case RESULT.CRIT: return "crit";
        case RESULT.HIT:
        case RESULT.STRUCK:
        case RESULT.FAILED: return "hit";
        case RESULT.SAVED: return "saved";
        case RESULT.MANUAL:
        case RESULT.AREA:
        case RESULT.PENDING: return "manual";
        default: return "miss";
    }
}

function speaker(wf) {
    const a = wf.attacker;
    return { scene: a.sceneId, token: a.tokenId, actor: a.actorId, alias: a.name };
}

const AREA_WORD = { blast: "Blast", line: "Line", automatic: "Automatic", explode: "Explode" };

function header(wf, gm) {
    const opts = (wf.options ?? []).map(k => ATTACK_OPTIONS[k]?.short).filter(Boolean);
    if (wf.nonlethal && !wf.options?.includes("nonlethal")) opts.push("Nonlethal");
    if (wf.cover && wf.cover !== "none") opts.push(`${COVER[wf.cover]?.short} cover`);
    if (AREA_WORD[wf.kind]) opts.unshift(AREA_WORD[wf.kind]);
    if (wf.save?.label && isSaveKind(wf)) opts.push(`${wf.save.label} save`);
    if (wf.mode?.label) opts.push(wf.mode.label);
    const title = gm ? wf.item.name : (wf.item.publicName ?? wf.item.name);
    return `<header class="sca-head">
        <img src="${esc(wf.item.img)}" alt="">
        <div class="sca-title-wrap">
            <div class="sca-title">${esc(title)}</div>
            <div class="sca-sub">${esc(wf.attacker.name)}${opts.length ? ` · ${esc(opts.join(", "))}` : ""}</div>
        </div>
        ${gm ? `<span class="sca-gm-badge">GM</span>` : ""}
    </header>`;
}

/** What the table sees for one target. */
function resultText(t, wf) {
    if (t.result === RESULT.SAVED && t.evaded) return "Saved: Evasion";
    if (t.result === RESULT.FAILED && t.evaded === "improved") return "Failed: Improved Evasion";
    if (t.result === RESULT.BLOCKED && isSaveKind(wf)) return "Unaffected";
    return RESULT_LABEL[t.result] ?? t.result;
}

function publicRow(t, wf) {
    const ap = t.applied;
    const undone = wf.undone;
    let extra = "";
    if (t.stopped) extra += `<span class="sca-status">Line stopped</span>`;
    if (t.save?.rider && !undone) extra += `<span class="sca-status">${esc(SAVE_LABEL[wf.rider?.type] ?? "")}: ${t.save.saved ? "saved" : "failed"}</span>`;
    if (t.riderPending) extra += `<span class="sca-status">Save: rolling…</span>`;
    let dmg = "";
    if (ap && !undone) dmg = `<span class="sca-dmg">${ap.dealt} damage</span>`;
    else if (!undone && isSaveKind(wf) && !wf.save?.noEffect && !wf.saveOnly && t.result !== RESULT.PENDING && (t.factor ?? 0) === 0) dmg = `<span class="sca-dmg">no damage</span>`;
    const status = ap?.status && !undone ? `<span class="sca-status">${esc(ap.status)}</span>` : "";
    return `<li class="sca-row sca-${resultClass(t.result)}">
        <img src="${esc(t.img)}" alt="">
        <span class="sca-name">${esc(t.name)}</span>
        <span class="sca-res">${esc(resultText(t, wf))}</span>${extra}${dmg}${status}${publicEffects(t, wf)}
    </li>`;
}

function publicExplodeLine(wf) {
    if (wf.kind !== KIND.EXPLODE) return "";
    const a = wf.attack;
    if (a.hit) return `<div class="sca-line">On target${a.nat === 20 ? " (natural 20)" : ""}.</div>`;
    const s = wf.scatter;
    if (!s) return `<div class="sca-line">Missed.</div>`;
    return `<div class="sca-line">Missed: it landed ${s.squares} square${s.squares === 1 ? "" : "s"} ${esc(compass(s.eighth))} of the aim point.</div>`;
}

export function publicContent(wf) {
    const empty = !wf.targets.length ? `<div class="sca-line sca-notes">No one in the area.</div>` : "";
    return `<div class="sca-card${wf.undone ? " sca-undone" : ""}">
        ${header(wf, false)}
        ${publicExplodeLine(wf)}
        <ul class="sca-targets">${wf.targets.map(t => publicRow(t, wf)).join("")}</ul>
        ${empty}
        ${wf.ammo?.notAttacked?.length ? `<div class="sca-line sca-notes">Out of ammunition before ${esc(wf.ammo.notAttacked.join(", "))}</div>` : ""}
        ${wf.undone ? `<footer class="sca-foot">Undone by the GM</footer>` : ""}
    </div>`;
}

/* ---------- GM card ---------- */

function damageLines(ap) {
    if (!ap) return "";
    const b = ap.before, a = ap.after;
    const pools = [];
    if (b.temp || a.temp) pools.push(`Temp ${b.temp}→${a.temp}`);
    if (b.spMax) pools.push(`SP ${b.sp}→${a.sp}`);
    pools.push(`HP ${b.hp}→${a.hp}`);
    return `<div class="sca-line">${ap.math.map(esc).join("<br>")}</div>
        <div class="sca-line"><b>Dealt ${ap.dealt}</b> · ${esc(pools.join(" · "))}${ap.status ? ` · <b>${esc(ap.status)}</b>` : ""}</div>`;
}

const btn = (action, label, i, value) =>
    `<button type="button" class="sca-btn" data-sca-action="${action}"${i != null ? ` data-sca-index="${i}"` : ""}${value ? ` data-sca-value="${value}"` : ""}>${label}</button>`;

/** Layer 3 lines for the GM card: conditions, critical hit effects, Remove and pick buttons. */
function gmEffectLines(t, i, wf) {
    const s = effectSummary(t);
    if (!s) return "";
    const out = [];
    if (s.conds.length) {
        out.push(`<div class="sca-line sca-l3"><i class="fa-solid fa-circle-exclamation"></i> ${esc(s.conds.map(c => c.text + (c.assumed ? " (no duration listed)" : "")).join(" · "))}</div>`);
    }
    s.crits.forEach((c, li) => {
        const picks = (c.choices ?? []).map(ch => btn("pick", esc(ch.name), i, `${li}|${ch.tokenUuid}`)).join("");
        out.push(`<div class="sca-line sca-l3"><i class="fa-solid fa-burst"></i> Crit: ${esc(c.gmText ?? c.text)}${picks && !wf.undone ? `<span class="sca-picks">${picks}</span>` : ""}</div>`);
    });
    if (s.resave) out.push(`<div class="sca-line sca-notes">It can try a new save each round on its turn (roll it by hand; Remove conditions on a success)</div>`);
    const active = (t.l3.conds ?? []).some(r => !r.removed && (r.applied || r.extended)) || (t.l3.crit ?? []).some(l => (l.rec && !l.rec.removed && l.rec.applied) || (l.ongoing && !l.ongoing.removed && l.ongoing.applied));
    if (active && !wf.undone) out.push(`<div class="sca-line sca-share">${btn("uncond", "Remove conditions", i)}</div>`);
    return out.join("");
}

/** Layer 3 for the public card: what happened, without DCs. */
function publicEffects(t, wf) {
    if (wf.undone) return "";
    const s = effectSummary(t);
    if (!s) return "";
    const bits = [...s.conds.filter(c => !c.gm).map(c => c.text), ...s.crits.map(c => `crit: ${c.text}`)];
    return bits.length ? `<span class="sca-status sca-l3">${esc(bits.join(" · "))}</span>` : "";
}

function byText(by) {
    if (!by || by === "gm") return "rolled by the GM's client";
    if (by.startsWith("player:")) return `rolled by ${by.slice(7)}`;
    if (by.startsWith("gm:")) return `GM rolled (${by.slice(3)})`;
    return by;
}

function saveLine(s, label) {
    if (!s || s.none) return "";
    const parts = [`d20 ${s.d20 ?? "?"}`];
    const bonus = (s.roll ?? 0) - (s.d20 ?? 0);
    parts.push(signed(bonus));
    if (s.cover) parts.push(`${signed(s.cover)} cover`);
    const verdict = s.saved ? "saved" : "failed";
    const auto = s.d20 === 20 ? " (natural 20)" : s.d20 === 1 ? " (natural 1)" : "";
    return `<div class="sca-line">${esc(label)} ${esc(parts.join(" "))} = ${s.total} vs DC ${s.dc}: <b>${verdict}</b>${auto} · ${esc(byText(s.by))}</div>`;
}

function evasionLine(t) {
    const s = t.save;
    if (!s) return "";
    if (t.evaded === "evasion") return `<div class="sca-line">Evasion: no damage on a save</div>`;
    if (t.evaded === "improved") return `<div class="sca-line">Improved Evasion: half on a failed save</div>`;
    if (s.evasionLost) return `<div class="sca-line sca-notes">${esc(s.evasionHad === "improved" ? "Improved Evasion" : "Evasion")} doesn't apply (${esc(s.evasionLost)})</div>`;
    return "";
}

function srLine(t) {
    if (!t.sr) return "";
    return `<div class="sca-line">SR ${t.sr.sr}: d20 ${t.sr.d20} + CL ${t.sr.cl} = ${t.sr.total}: <b>${t.sr.overcome ? "overcome" : "resisted"}</b></div>`;
}

function gmSaveRow(t, i, wf) {
    const ap = t.applied;
    const res = resultText(t, wf);
    const notes = [...(t.notes ?? [])];
    if (t.critTarget) notes.push("critical hit: nearest the intersection");
    if (t.flipped) notes.push("changed by GM");
    if (t.override) notes.push(`set to ${t.override} by GM`);
    if (t.note) notes.push(t.note);
    if (t.factor === 0.5 && !ap && !t.flagged && t.result !== RESULT.PENDING) notes.push("half damage");
    const noteLine = notes.length ? `<div class="sca-line sca-notes">${esc(notes.join(" · "))}</div>` : "";
    const rangeLine = t.rangeWarning
        ? `<div class="sca-line sca-warn"><i class="fa-solid fa-triangle-exclamation"></i> Out of range: ${esc(t.rangeWarning.distance)} ft away, range ${esc(t.rangeWarning.range)} ft</div>`
        : "";
    const flagLine = t.flagged
        ? `<div class="sca-line sca-warn"><i class="fa-solid fa-flag"></i> ${esc(wf.save?.note || "check the effect")}: half applied</div>`
        : "";
    const pending = t.result === RESULT.PENDING;
    const buttons = [];
    if (!wf.undone && !pending && wf.kind !== KIND.DAMAGE && t.result !== RESULT.MANUAL) {
        if (t.result === RESULT.SAVED) buttons.push(btn("flipsave", "Make failed", i));
        else if (t.result === RESULT.FAILED) buttons.push(btn("flipsave", "Make saved", i));
        else if (t.result === RESULT.RESISTED) buttons.push(btn("flipsave", "Not resisted", i));
        else if (t.result === RESULT.BLOCKED) buttons.push(btn("flipsave", "Roll save", i));
    }
    const shares = (!wf.undone && !pending && (t.flagged || t.override || t.result === RESULT.MANUAL))
        ? `<div class="sca-line sca-share">${btn("share", "Full", i, "full")}${btn("share", "Half", i, "half")}${btn("share", "None", i, "none")}</div>`
        : "";
    const noDamage = !wf.damage?.normal?.length && !wf.damage?.crit?.length;
    if (!ap && !wf.undone && !pending && (t.factor ?? 0) > 0 && !(noDamage && (t.l3 || !wf.item?.effects))) buttons.push(btn("apply", "Apply", i));
    return `<li class="sca-row sca-gm-row sca-${resultClass(t.result)}">
        <div class="sca-row-head">
            <img src="${esc(t.img)}" alt="">
            <span class="sca-name">${esc(t.name)}</span>
            <span class="sca-res">${esc(res)}</span>
            ${buttons.join("")}
        </div>
        ${rangeLine}${srLine(t)}${saveLine(t.save, wf.save?.label ?? "")}${evasionLine(t)}${flagLine}${shares}${noteLine}${damageLines(ap)}${gmEffectLines(t, i, wf)}
    </li>`;
}

function gmAttackRow(t, i, wf) {
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
        if (t.areaPenalty) rollParts.push(`${t.areaPenalty} ${wf.kind}`);
        if (t.helplessBonus) rollParts.push(`+${t.helplessBonus} helpless`);
        const effRoll = rollParts.length > 1 ? `${rollParts.join(" ")} = ${t.effTotal}` : `${t.rollTotal}`;
        const effAc = acParts.length > 1 ? `${acParts.join(" ")} = ${t.effAc}` : `${ac} ${t.baseAc}`;
        roll = `<div class="sca-line">d20 ${t.nat ?? "?"}: ${esc(effRoll)} vs ${esc(effAc)}</div>`;
    }
    const notes = (t.notes ?? []).filter(n => !/^(blast|automatic) -\d/.test(n));
    if (t.range) notes.push(`${t.range.distance} ft (increment ${t.range.increment} ft)`);
    if (t.flipped) notes.push("flipped by GM");
    if (t.stopped) notes.push("line stopped by an earlier creature that took no damage");
    if (t.note) notes.push(t.note);
    const noteLine = notes.length ? `<div class="sca-line sca-notes">${esc(notes.join(" · "))}</div>` : "";
    const reachLine = t.reach?.outOfReach
        ? `<div class="sca-line sca-warn"><i class="fa-solid fa-triangle-exclamation"></i> Out of reach: ${esc(t.reach.distance)} ft away, reach ${esc(t.reach.reach)} ft</div>`
        : "";
    const riderLine = t.riderPending
        ? `<div class="sca-line sca-notes">${esc(wf.rider?.label ?? "")} save: rolling…</div>`
        : (t.save?.rider ? saveLine(t.save, wf.rider?.label ?? "") + evasionLine(t) : "");
    const hit = t.result === RESULT.HIT || t.result === RESULT.CRIT;
    const canApply = !ap && !wf.undone && hit && !t.stopped && !t.riderPending;
    const flipLabel = hit ? "Make miss" : "Make hit";
    return `<li class="sca-row sca-gm-row sca-${resultClass(t.result)}">
        <div class="sca-row-head">
            <img src="${esc(t.img)}" alt="">
            <span class="sca-name">${esc(t.name)}</span>
            <span class="sca-res">${esc(res)}</span>
            ${wf.undone ? "" : btn("flip", flipLabel, i)}
            ${canApply ? btn("apply", "Apply", i) : ""}
        </div>
        ${reachLine}${roll}${riderLine}${noteLine}${damageLines(ap)}${gmEffectLines(t, i, wf)}
    </li>`;
}

/** The top of the GM card: the attack (if any) and the DC. */
function gmSummary(wf) {
    const lines = [];
    if (wf.kind === KIND.EXPLODE) {
        const a = wf.attack;
        const pen = a.penalty ? ` ${a.penalty} range = ${a.eff}` : "";
        const dist = a.distance != null ? ` · ${a.distance} ft` : "";
        lines.push(`Attack ${a.total} (d20 ${a.nat ?? "?"})${pen} vs AC 5: <b>${a.hit ? "on target" : "missed"}</b>${esc(dist)}`);
        if (wf.scatter) {
            const s = wf.scatter;
            lines.push(`Scatter: d8 ${s.d8} (${esc(compass(s.eighth))}), d4 ${s.d4}: landed ${s.squares} square${s.squares === 1 ? "" : "s"} away`);
        }
        for (const n of a.notes ?? []) lines.push(`<span class="sca-warn">${esc(n)}</span>`);
    } else if (!isSaveKind(wf)) {
        const pen = wf.attack.penalty ? ` · ${wf.attack.penalty} ${wf.kind} each` : "";
        lines.push(`Attack ${wf.attack.total} (d20 ${wf.attack.nat ?? "?"})${esc(pen)}${wf.nonlethal ? " · nonlethal" : ""}`);
        if (wf.kind === KIND.BLAST || wf.kind === KIND.AUTOMATIC) lines.push(`<span class="sca-notes">A d20 per creature, nearest first${wf.kind === KIND.AUTOMATIC ? (wf.ammo ? "; no crits" : "; no crits; each creature uses two shots of ammo (spend by hand)") : ""}</span>`);
        if (wf.ammo) {
            const m = wf.ammo;
            lines.push(`<span class="sca-notes">Ammo: ${m.available} loaded, ${m.per} per creature: ${m.attacked} attacked; all of it used</span>`);
            if (m.notAttacked?.length) lines.push(`<span class="sca-warn">Out of ammo before: ${esc(m.notAttacked.join(", "))}</span>`);
        }
        if (wf.kind === KIND.LINE) lines.push(`<span class="sca-notes">One roll against each creature in the line, nearest first; only the first can be crit</span>`);
        if (wf.rider) lines.push(`${esc(wf.rider.label)} DC ${wf.rider.dc} on a hit (${esc(wf.rider.descriptor || "save")})`);
    }
    if (isSaveKind(wf) && wf.save?.noEffect) {
        lines.push(`No save and no damage: the rows show who's in the area`);
    } else if (isSaveKind(wf) && wf.save) {
        const parts = (wf.save.parts ?? []).map(p => `${signed(p.value)} ${p.label}`);
        const base = parts.length ? `${wf.save.base} ${parts.join(" ")} = ` : "";
        const half = wf.save.onSave === "half" ? "half" : wf.save.onSave === "none" ? "negates" : "no effect on damage";
        lines.push(`${esc(wf.save.label)} DC ${esc(base)}<b>${wf.save.dc}</b> (${half})${wf.item.allowsSR ? " · SR applies" : ""}`);
    } else if (wf.kind === KIND.DAMAGE) {
        lines.push(`No attack and no save: full damage to each target`);
        if (wf.targets.length > 1) lines.push(`<span class="sca-warn">Each of the ${wf.targets.length} targets took the whole roll. For an effect that splits (magic missile), Undo and roll one part per target.</span>`);
    }
    if (wf.manualParts?.length) {
        const list = wf.manualParts.map(p => `${esc(p.label)} ${esc(p.total)}`).join(" · ");
        lines.push(`<span class="sca-warn">Apply by hand (not taken off SP or HP): ${list}</span>`);
    }
    return lines.map(l => `<div class="sca-line">${l}</div>`).join("");
}

export function gmContent(wf) {
    const sections = (k) => (wf.damage?.[k] ?? []).map(s => `${s.total} (${s.formula})`).join(" + ");
    const dmgLine = [];
    if (wf.damage?.normal?.length) dmgLine.push(`Damage ${sections("normal")}`);
    if (wf.damage?.crit?.length) dmgLine.push(`Crit ${sections("crit")}`);
    const row = isSaveKind(wf) ? gmSaveRow : gmAttackRow;
    const empty = !wf.targets.length ? `<div class="sca-line sca-notes">No one in the area.</div>` : "";
    return `<div class="sca-card sca-gm${wf.undone ? " sca-undone" : ""}">
        ${header(wf, true)}
        ${gmSummary(wf)}
        ${dmgLine.length ? `<div class="sca-line">${esc(dmgLine.join(" · "))}</div>` : ""}
        <ul class="sca-targets">${wf.targets.map((t, i) => row(t, i, wf)).join("")}</ul>
        ${empty}
        <footer class="sca-foot">
            ${wf.undone
        ? `<span>Undone</span>${btn("redo", "Reapply")}`
        : btn("undo", "Undo")}
        </footer>
    </div>`;
}

/** Post both cards; returns the GM card's message. */
export async function createCards(wf) {
    const pub = await ChatMessage.create({
        speaker: speaker(wf),
        content: publicContent(wf),
        flags: { [MODULE_ID]: { public: true, workflowId: wf.workflowId } }
    });
    wf.publicMessageId = pub?.id ?? null;
    const gmIds = ChatMessage.getWhisperRecipients("GM").map(u => u.id);
    return ChatMessage.create({
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
    if (flags?.public) {
        // Hidden on GM screens by CSS when the setting is on (see applyGmView).
        el.classList.add("sca-public-msg");
        return;
    }
    if (!flags?.gm) return;
    if (!game.user.isGM) {
        el.querySelectorAll("[data-sca-action]").forEach(b => b.remove());
        return;
    }
    el.querySelectorAll("[data-sca-action]").forEach(button => {
        button.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const card = button.closest(".sca-card");
            card?.classList.add("sca-busy");
            try {
                const idx = button.dataset.scaIndex != null ? Number(button.dataset.scaIndex) : null;
                await gmAction(message, button.dataset.scaAction, idx, button.dataset.scaValue);
            } catch (err) {
                console.error(`${MODULE_ID} |`, err);
                ui.notifications.error(`Combat automation: ${err.message ?? err}`);
            } finally {
                card?.classList.remove("sca-busy");
            }
        });
    });
}
