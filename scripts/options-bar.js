/**
 * The sticky attack-options bar. Each toggle switches one of sfrpg's own global attack
 * modifiers on this client (sfrpg deep-clones the list per roll and quick rolls include
 * any entry that's enabled). Cover applies to the next attack and then resets.
 */
import { MODULE_ID, ATTACK_OPTIONS, COVER } from "./constants.js";
import { getSetting } from "./settings.js";

function globalMod(opt) {
    const list = CONFIG.SFRPG?.globalAttackRollModifiers ?? [];
    const found = list.find(m => m.bonus?._id === opt.id)
        ?? list.find(m => m.bonus?.name === opt.key || m.bonus?.name === game.i18n.localize(opt.key));
    return found?.bonus ?? null;
}

class AttackBar {
    constructor() {
        this.el = null;
        this.state = { options: {}, cover: "none" };
    }

    load() {
        const saved = foundry.utils.deepClone(game.settings.get(MODULE_ID, "barState") ?? {});
        this.state.options = saved.options ?? {};
        this.state.cover = "none";
        for (const k of Object.keys(ATTACK_OPTIONS)) this.#sync(k);
    }

    save() {
        game.settings.set(MODULE_ID, "barState", { options: this.state.options });
    }

    #sync(k) {
        const mod = globalMod(ATTACK_OPTIONS[k]);
        if (mod) mod.enabled = !!this.state.options[k];
    }

    isOn(k) {
        return !!this.state.options[k];
    }

    activeOptionKeys() {
        return Object.keys(ATTACK_OPTIONS).filter(k => this.state.options[k]);
    }

    toggle(k, value) {
        this.state.options[k] = value ?? !this.state.options[k];
        this.#sync(k);
        this.save();
        this.render();
    }

    setCover(c) {
        this.state.cover = this.state.cover === c ? "none" : c;
        this.render();
    }

    /** Read the cover for this attack and reset it. */
    consumeCover() {
        const c = this.state.cover;
        if (c !== "none") {
            this.state.cover = "none";
            this.render();
        }
        return c;
    }

    /** Full attack lasts until the end of the turn. */
    onTurnChange() {
        if (this.state.options.fullAttack) this.toggle("fullAttack", false);
    }

    close() {
        this.el?.remove();
        this.el = null;
        for (const k of Object.keys(ATTACK_OPTIONS)) {
            const mod = globalMod(ATTACK_OPTIONS[k]);
            if (mod) mod.enabled = false;
        }
    }

    render() {
        if (!getSetting("showBar")) {
            this.el?.remove();
            this.el = null;
            return;
        }
        if (!this.el) {
            this.el = document.createElement("div");
            this.el.id = "sca-bar";
            this.el.addEventListener("click", (ev) => this.#onClick(ev));
            const anchor = document.getElementById("ui-bottom") ?? document.body;
            const hotbar = document.getElementById("hotbar");
            if (hotbar && hotbar.parentElement === anchor) anchor.insertBefore(this.el, hotbar);
            else anchor.appendChild(this.el);
        }
        const opt = Object.entries(ATTACK_OPTIONS).map(([k, o]) =>
            `<button type="button" data-sca-opt="${k}" class="${this.isOn(k) ? "on" : ""}" data-tooltip="${o.label}: ${o.hint}">${o.short}</button>`
        ).join("");
        const cov = Object.entries(COVER).filter(([k]) => k !== "none").map(([k, c]) =>
            `<button type="button" data-sca-cover="${k}" class="${this.state.cover === k ? "on" : ""}" data-tooltip="${c.label}, next attack only">${c.short}</button>`
        ).join("");
        const gm = game.user.isGM
            ? `<span class="sca-sep"></span><button type="button" data-sca-gm="flatfooted" data-tooltip="Toggle flat-footed on the targeted tokens">Flat-footed</button>`
            : "";
        this.el.innerHTML = `<span class="sca-label">Attack</span>${opt}<span class="sca-sep"></span><span class="sca-label">Cover</span>${cov}${gm}`;
    }

    async #onClick(ev) {
        const b = ev.target.closest("button");
        if (!b) return;
        if (b.dataset.scaOpt) this.toggle(b.dataset.scaOpt);
        else if (b.dataset.scaCover) this.setCover(b.dataset.scaCover);
        else if (b.dataset.scaGm === "flatfooted") {
            const targets = [...game.user.targets].filter(t => t.actor);
            if (!targets.length) return ui.notifications.info("Target one or more tokens first.");
            for (const t of targets) {
                await t.actor.setCondition("flat-footed", !t.actor.hasCondition("flat-footed"));
            }
        }
    }
}

export const bar = new AttackBar();
