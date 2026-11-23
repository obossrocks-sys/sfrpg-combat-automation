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
        this.state = { options: {}, cover: "none", auto: false, collapsed: false };
        /** Modal weapons: the mode picked for each item this session (itemUuid -> part index). */
        this.modes = new Map();
    }

    load() {
        const saved = foundry.utils.deepClone(game.settings.get(MODULE_ID, "barState") ?? {});
        this.state.options = saved.options ?? {};
        this.state.collapsed = !!saved.collapsed;
        this.state.pos = saved.pos ?? null;
        this.state.cover = "none";
        for (const k of Object.keys(ATTACK_OPTIONS)) this.#sync(k);
    }

    save() {
        game.settings.set(MODULE_ID, "barState", { options: this.state.options, collapsed: this.state.collapsed, pos: this.state.pos ?? null });
    }

    /** Hide the bar down to a small tab, or show it again (this user only; options stay as they are). */
    toggleCollapsed() {
        this.state.collapsed = !this.state.collapsed;
        this.save();
        this.render();
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

    /** The GM's cover pick, shared with every client (a world setting only the GM writes). */
    gmCover() {
        try { return game.settings.get(MODULE_ID, "gmCover") || "none"; } catch (e) { return "none"; }
    }

    /** The cover the bar shows as picked: the GM's shared pick, or this user's own. */
    shownCover() {
        return game.user.isGM ? this.gmCover() : this.state.cover;
    }

    setCover(c) {
        if (game.user.isGM) {
            // The GM rules on cover: the pick applies to the next attack or effect by anyone.
            game.settings.set(MODULE_ID, "gmCover", this.gmCover() === c ? "none" : c);
            return;
        }
        this.state.cover = this.state.cover === c ? "none" : c;
        this.render();
    }

    /**
     * Read the cover for this attack and reset it: the higher of this user's pick and the GM's
     * shared pick. Returns { cover, fromGm } (the GM's client clears its shared pick when the
     * attack or effect reaches it).
     */
    consumeCoverInfo() {
        const own = this.state.cover, gm = this.gmCover();
        const order = Object.keys(COVER);
        const cover = order.indexOf(gm) > order.indexOf(own) ? gm : own;
        const fromGm = gm !== "none" && cover === gm;
        if (own !== "none") {
            this.state.cover = "none";
            this.render();
        }
        if (fromGm && game.user.isGM) game.settings.set(MODULE_ID, "gmCover", "none");
        return { cover, fromGm };
    }

    consumeCover() {
        return this.consumeCoverInfo().cover;
    }

    clearModes() {
        this.modes.clear();
        ui.notifications.info("Modal weapons will ask for their mode on the next attack.");
    }

    toggleAuto() {
        this.state.auto = !this.state.auto;
        this.render();
    }

    /** Automatic mode applies to the next attack and then resets. */
    consumeAuto() {
        const a = !!this.state.auto;
        if (a) {
            this.state.auto = false;
            this.render();
        }
        return a;
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
            this.el.addEventListener("pointerdown", (ev) => this.#onGrip(ev));
            this.el.addEventListener("dblclick", (ev) => { if (ev.target.closest(".sca-grip")) this.dock(); });
        }
        this.#place();
        const grip = `<span class="sca-grip" data-tooltip="Drag to move the bar anywhere; double-click to put it back under the hotbar"><i class="fa-solid fa-grip-vertical"></i></span>`;
        const collapsed = !!this.state.collapsed;
        this.el.classList.toggle("sca-collapsed", collapsed);
        const toggle = `<button type="button" class="sca-collapse" data-sca-collapse="1" data-tooltip="${collapsed ? "Show" : "Hide"} the attack-options bar"><i class="fa-solid fa-chevron-${collapsed ? "right" : "left"}"></i></button>`;
        if (collapsed) {
            // Keep anything that's switched on in view, so a hidden bar never hides a penalty.
            const on = [
                ...Object.entries(ATTACK_OPTIONS).filter(([k]) => this.isOn(k)).map(([, o]) => o.short),
                ...(this.state.auto ? ["Auto"] : []),
                ...(this.shownCover() !== "none" ? [`${COVER[this.shownCover()]?.short} cover`] : []),
                ...(!game.user.isGM && this.gmCover() !== "none" ? [`GM: ${COVER[this.gmCover()]?.short} cover`] : [])
            ];
            this.el.innerHTML = `${grip}${toggle}<span class="sca-label">Attack</span>${on.length ? `<span class="sca-on">${on.join(" · ")}</span>` : ""}`;
            return;
        }
        const opt = Object.entries(ATTACK_OPTIONS).map(([k, o]) =>
            `<button type="button" data-sca-opt="${k}" class="${this.isOn(k) ? "on" : ""}" data-tooltip="${o.label}: ${o.hint}">${o.short}</button>`
        ).join("");
        const cov = Object.entries(COVER).filter(([k]) => k !== "none").map(([k, c]) =>
            `<button type="button" data-sca-cover="${k}" class="${this.shownCover() === k ? "on" : ""}" data-tooltip="${c.label}, next attack or effect only${game.user.isGM ? " (anyone's)" : ""}">${c.short}</button>`
        ).join("");
        const gm = game.user.isGM
            ? `<span class="sca-sep"></span><button type="button" data-sca-gm="flatfooted" data-tooltip="Toggle flat-footed on the targeted tokens">Flat-footed</button>`
            : "";
        const mode = `<button type="button" data-sca-mode="1" data-tooltip="Modal weapons: pick the mode again on the next attack">Mode</button>`;
        const auto = `<button type="button" data-sca-auto="1" class="${this.state.auto ? "on" : ""}" data-tooltip="Automatic mode, next attack only: an automatic weapon fires at every creature in a cone of half its range increment, a d20 each at -4, no crits">Auto</button>`;
        const gmPick = !game.user.isGM && this.gmCover() !== "none"
            ? `<span class="sca-gmcover" data-tooltip="The GM set cover for the next attack or effect">GM: ${COVER[this.gmCover()]?.short}</span>` : "";
        this.el.innerHTML = `${grip}${toggle}<span class="sca-label">Attack</span>${opt}${auto}${mode}<span class="sca-sep"></span><span class="sca-label">Cover</span>${cov}${gmPick}${gm}`;
    }

    /** Dock under the hotbar, or float at the saved spot (kept inside the window). */
    #place() {
        const el = this.el, pos = this.state.pos;
        if (pos) {
            if (el.parentElement !== document.body) document.body.appendChild(el);
            el.classList.add("sca-float");
            const w = el.offsetWidth || 300, h = el.offsetHeight || 30;
            const x = Math.max(0, Math.min(window.innerWidth - Math.min(w, window.innerWidth), pos.x));
            const y = Math.max(0, Math.min(window.innerHeight - h, pos.y));
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            return;
        }
        el.classList.remove("sca-float");
        el.style.left = el.style.top = "";
        const anchor = document.getElementById("ui-bottom") ?? document.body;
        const hotbar = document.getElementById("hotbar");
        if (el.parentElement === anchor) return;
        if (hotbar && hotbar.parentElement === anchor) anchor.insertBefore(el, hotbar);
        else anchor.appendChild(el);
    }

    /** Put the bar back under the hotbar. */
    dock() {
        this.state.pos = null;
        this.save();
        this.render();
    }

    /** Drag by the grip; the spot is saved for this user. */
    #onGrip(ev) {
        if (ev.button !== 0 || !ev.target.closest(".sca-grip")) return;
        ev.preventDefault();
        const el = this.el, r = el.getBoundingClientRect();
        const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
        if (!this.state.pos) {
            this.state.pos = { x: r.left, y: r.top };
            this.#place();
        }
        const move = (e) => {
            this.state.pos = { x: e.clientX - dx, y: e.clientY - dy };
            this.#place();
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            this.save();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    async #onClick(ev) {
        const b = ev.target.closest("button");
        if (!b) return;
        if (b.dataset.scaCollapse) this.toggleCollapsed();
        else if (b.dataset.scaOpt) this.toggle(b.dataset.scaOpt);
        else if (b.dataset.scaCover) this.setCover(b.dataset.scaCover);
        else if (b.dataset.scaAuto) this.toggleAuto();
        else if (b.dataset.scaMode) this.clearModes();
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
