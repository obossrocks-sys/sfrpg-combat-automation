export const MODULE_ID = "sfrpg-combat-automation";

/** Damage types that count as kinetic for AC and DR purposes. */
export const KINETIC = ["bludgeoning", "piercing", "slashing"];
/** Energy types. */
export const ENERGY = ["acid", "cold", "electricity", "fire", "sonic"];

/** Cover levels, AC bonus to the target (CRB 253). Total cover can't be attacked. */
export const COVER = {
    none: { label: "No cover", short: "None", ac: 0, reflex: 0 },
    partial: { label: "Partial cover (+2 AC, +1 Reflex)", short: "Partial", ac: 2, reflex: 1 },
    cover: { label: "Cover (+4 AC, +2 Reflex)", short: "Cover", ac: 4, reflex: 2 },
    improved: { label: "Improved cover (+8 AC, +4 Reflex)", short: "Improved", ac: 8, reflex: 4 },
    total: { label: "Total cover (can't be attacked or affected)", short: "Total", ac: null, reflex: null }
};

/**
 * The attack options the bar drives. Each maps to one of sfrpg's own global attack
 * modifiers (CONFIG.SFRPG.globalAttackRollModifiers), found by its fixed _id (sfrpg
 * localizes the names at startup, so the name key can't be matched).
 */
export const ATTACK_OPTIONS = {
    fullAttack: { mod: -4, id: "9752a0ff-ee73-4fac-8d4a-f6822135d8fc", label: "Full attack", short: "Full", key: "SFRPG.Rolls.Character.FullAttack", hint: "-4 to each attack; clears at the end of the turn" },
    flanking: { mod: 2, id: "5eb1f127-31e1-47d9-bd9e-cd2a68b8d8eb", label: "Flanking", short: "Flank", key: "SFRPG.Rolls.Character.Flanking", hint: "+2" },
    nonlethal: { mod: -4, id: "a64aabd8-8704-4420-8c43-dab851ccf83d", label: "Nonlethal", short: "Nonlethal", key: "SFRPG.Rolls.Character.Nonlethal", hint: "-4; damage is nonlethal" },
    fightDefensively: { mod: -4, id: "2e72e48a-d152-4b25-97fc-5f5485ba6027", label: "Fight defensively", short: "Defensive", key: "SFRPG.Rolls.Character.FightDefensively", hint: "-4" },
    charge: { mod: -2, id: "e10bf545-4c36-4072-b8e7-ef791cfdaae5", label: "Charge", short: "Charge", key: "SFRPG.Rolls.Character.Charge", hint: "-2" },
    harryingFire: { mod: 2, id: "12dfb463-9a24-483a-85e4-8d43ea23f871", label: "Harrying fire", short: "Harrying", key: "SFRPG.Rolls.Character.HarryingFire", hint: "+2" }
};

export const RESULT = {
    HIT: "hit",
    CRIT: "crit",
    MISS: "miss",
    BLOCKED: "blocked",
    MANUAL: "manual",
    // Layer 2: save effects
    FAILED: "failed",
    SAVED: "saved",
    RESISTED: "resisted",
    PENDING: "pending",
    STRUCK: "struck",
    // v0.2.1: in an area with no save and no damage (a smoke grenade's cloud)
    AREA: "area"
};

export const RESULT_LABEL = {
    hit: "Hit",
    crit: "Critical hit",
    miss: "Miss",
    blocked: "Miss",
    manual: "GM call",
    failed: "Failed",
    saved: "Saved",
    resisted: "Resisted",
    pending: "Rolling…",
    struck: "Hit",
    area: "In the area"
};

/** Workflow kinds. "attack" is layer 1; the rest are layer 2. */
export const KIND = {
    ATTACK: "attack",
    SAVE: "save",
    DAMAGE: "damage",
    EXPLODE: "explode",
    BLAST: "blast",
    LINE: "line",
    AUTOMATIC: "automatic"
};
