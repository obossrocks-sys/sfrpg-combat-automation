export const MODULE_ID = "sfrpg-combat-automation";

/** Damage types that count as kinetic for AC and DR purposes. */
export const KINETIC = ["bludgeoning", "piercing", "slashing"];
/** Energy types. */
export const ENERGY = ["acid", "cold", "electricity", "fire", "sonic"];

/** Cover levels, AC bonus to the target (CRB 253). Total cover can't be attacked. */
export const COVER = {
    none: { label: "No cover", short: "None", ac: 0 },
    partial: { label: "Partial cover (+2 AC)", short: "Partial", ac: 2 },
    cover: { label: "Cover (+4 AC)", short: "Cover", ac: 4 },
    improved: { label: "Improved cover (+8 AC)", short: "Improved", ac: 8 },
    total: { label: "Total cover (can't be attacked)", short: "Total", ac: null }
};

/**
 * The attack options the bar drives. Each maps to one of sfrpg's own global attack
 * modifiers (CONFIG.SFRPG.globalAttackRollModifiers), found by its fixed _id (sfrpg
 * localizes the names at startup, so the name key can't be matched).
 */
export const ATTACK_OPTIONS = {
    fullAttack: { id: "9752a0ff-ee73-4fac-8d4a-f6822135d8fc", label: "Full attack", short: "Full", key: "SFRPG.Rolls.Character.FullAttack", hint: "-4 to each attack; clears at the end of the turn" },
    flanking: { id: "5eb1f127-31e1-47d9-bd9e-cd2a68b8d8eb", label: "Flanking", short: "Flank", key: "SFRPG.Rolls.Character.Flanking", hint: "+2" },
    nonlethal: { id: "a64aabd8-8704-4420-8c43-dab851ccf83d", label: "Nonlethal", short: "Nonlethal", key: "SFRPG.Rolls.Character.Nonlethal", hint: "-4; damage is nonlethal" },
    fightDefensively: { id: "2e72e48a-d152-4b25-97fc-5f5485ba6027", label: "Fight defensively", short: "Defensive", key: "SFRPG.Rolls.Character.FightDefensively", hint: "-4" },
    charge: { id: "e10bf545-4c36-4072-b8e7-ef791cfdaae5", label: "Charge", short: "Charge", key: "SFRPG.Rolls.Character.Charge", hint: "-2" },
    harryingFire: { id: "12dfb463-9a24-483a-85e4-8d43ea23f871", label: "Harrying fire", short: "Harrying", key: "SFRPG.Rolls.Character.HarryingFire", hint: "+2" }
};

export const RESULT = {
    HIT: "hit",
    CRIT: "crit",
    MISS: "miss",
    BLOCKED: "blocked",
    MANUAL: "manual"
};

export const RESULT_LABEL = {
    hit: "Hit",
    crit: "Critical hit",
    miss: "Miss",
    blocked: "Miss",
    manual: "GM call"
};
