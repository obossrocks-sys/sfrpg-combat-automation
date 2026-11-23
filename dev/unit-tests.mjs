/**
 * Unit tests for the pure rules in scripts/logic.js (no Foundry needed).
 * Run: node dev/unit-tests.mjs
 */
import assert from "node:assert/strict";
import {
    saveSucceeds, saveEffect, damageFactor, scaled, rangePenaltyFor, scatterStep, compass,
    feetIn, areaSpec, stripDCs, isAbilityDamagePart, isHealingPart, partName, mindImmune
} from "../scripts/logic.js";
import { norm, matchWeapon, isIntegrated, pickAmmo, packOfSize, defaultSpareLoads, parseGoodsAmmo, spareFits } from "../scripts/npc-ammo-logic.js";
import { parseEffectText, linkedConditions, effectsFromItem, spellDurationField, parseCrit, critSaveDC, immuneTo, roundsIn, isDue, durationLabel, allowsNewSave } from "../scripts/effects.js";

let passed = 0;
const test = (name, fn) => {
    try {
        fn();
        passed++;
    } catch (err) {
        console.error(`FAIL ${name}\n  ${err.message}`);
        process.exitCode = 1;
    }
};

// Saves: natural 1 and 20 (CRB 241)
test("nat 20 saves even below DC", () => assert.equal(saveSucceeds(20, 5, 30), true));
test("nat 1 fails even above DC", () => assert.equal(saveSucceeds(1, 40, 10), false));
test("meets DC saves", () => assert.equal(saveSucceeds(10, 15, 15), true));
test("below DC fails", () => assert.equal(saveSucceeds(10, 14, 15), false));

// Descriptors
test("half", () => assert.deepEqual(saveEffect("half"), { onSave: "half", flagged: false, note: "" }));
test("negate", () => assert.equal(saveEffect("negate").onSave, "none"));
test("partial is half and flagged", () => {
    const e = saveEffect("partial");
    assert.equal(e.onSave, "half");
    assert.equal(e.flagged, true);
});
test("explode is always half", () => assert.equal(saveEffect("negate", { explode: true }).onSave, "half"));
test("empty descriptor flagged half", () => assert.equal(saveEffect("").flagged, true));
test("object: no save", () => assert.equal(saveEffect("object").noSave, true));

// Damage share and Evasion
test("failed: full", () => assert.equal(damageFactor({ saved: false, onSave: "half" }).factor, 1));
test("saved half: 0.5", () => assert.equal(damageFactor({ saved: true, onSave: "half" }).factor, 0.5));
test("saved negate: 0", () => assert.equal(damageFactor({ saved: true, onSave: "none" }).factor, 0));
test("evasion saved reflex half: 0", () => {
    const f = damageFactor({ saved: true, onSave: "half", evasion: "evasion", isReflex: true });
    assert.equal(f.factor, 0);
    assert.equal(f.evaded, "evasion");
});
test("evasion failed: full", () => assert.equal(damageFactor({ saved: false, onSave: "half", evasion: "evasion", isReflex: true }).factor, 1));
test("improved evasion failed: half", () => {
    const f = damageFactor({ saved: false, onSave: "half", evasion: "improved", isReflex: true });
    assert.equal(f.factor, 0.5);
    assert.equal(f.evaded, "improved");
});
test("evasion ignores Fort saves", () => assert.equal(damageFactor({ saved: true, onSave: "half", evasion: "evasion", isReflex: false }).factor, 0.5));
test("evasion ignores negate effects", () => assert.equal(damageFactor({ saved: false, onSave: "none", evasion: "improved", isReflex: true }).factor, 1));

// Halving rounds down
test("half of 17 is 8", () => assert.equal(scaled(17, 0.5), 8));
test("half of 1 is 0", () => assert.equal(scaled(1, 0.5), 0));
test("full keeps", () => assert.equal(scaled(9, 1), 9));
test("none is 0", () => assert.equal(scaled(9, 0), 0));

// Range (CRB 245)
test("inside first increment", () => assert.equal(rangePenaltyFor(20, 20).penalty, 0));
test("second increment -2", () => assert.equal(rangePenaltyFor(25, 20).penalty, -2));
test("Far Shot -1", () => assert.equal(rangePenaltyFor(45, 20, { farShot: true }).penalty, -2));
test("thrown max 5 increments", () => assert.equal(rangePenaltyFor(105, 20, { thrown: true }).outOfRange, true));
test("thrown 100 ft at 20 ok", () => assert.equal(rangePenaltyFor(100, 20, { thrown: true }).outOfRange, false));
test("no negative zero", () => assert.ok(Object.is(rangePenaltyFor(10, 20).penalty, 0)));

// Scatter (CRB 245): thrower directly south of the aim point
const aim = { x: 0, y: 0 };
const south = { x: 0, y: 100 };
test("d8 1 falls short (south, toward thrower)", () => {
    const s = scatterStep(aim, south, 1, 3);
    assert.deepEqual([s.di, s.dj, compass(s.eighth)], [0, 3, "south"]);
});
test("d8 2 is southwest (clockwise)", () => {
    const s = scatterStep(aim, south, 2, 1);
    assert.deepEqual([s.di, s.dj, compass(s.eighth)], [-1, 1, "southwest"]);
});
test("d8 3 is west", () => assert.equal(compass(scatterStep(aim, south, 3, 1).eighth), "west"));
test("d8 5 is north (past the target)", () => {
    const s = scatterStep(aim, south, 5, 2);
    assert.deepEqual([s.di, s.dj], [0, -2]);
});
test("d8 8 is southeast", () => assert.equal(compass(scatterStep(aim, south, 8, 1).eighth), "southeast"));
test("thrower east: d8 1 goes east", () => assert.equal(compass(scatterStep(aim, { x: 300, y: 0 }, 1, 1).eighth), "east"));
test("thrower northwest: d8 1 goes northwest", () => assert.equal(compass(scatterStep(aim, { x: -50, y: -50 }, 1, 1).eighth), "northwest"));

// Areas from data and weapon properties
test("feetIn", () => assert.equal(feetIn("explode (1d6 P, 15 ft.)"), 15));
test("frag grenade burst 15", () => {
    const s = areaSpec({ properties: { explode: { value: true } }, area: { shape: "sphere", units: "ft", value: "15" }, range: { units: "ft", value: "20" } });
    assert.deepEqual(s, { kind: "explode", t: "circle", distance: 15 });
});
test("explode radius from the property text", () => {
    const s = areaSpec({ properties: { explode: { value: true, extension: "10 ft" } }, area: {}, range: { units: "ft", value: "60" } });
    assert.equal(s.distance, 10);
});
test("explode with no radius is a guess", () => {
    const s = areaSpec({ properties: { explode: { value: true } }, area: {}, range: { units: "ft", value: "20" } });
    assert.equal(s.guessed, true);
});
test("explode radius from the description", () => {
    const s = areaSpec({ properties: { explode: { value: true } }, area: {}, range: { units: "ft", value: "60" } }, { description: "<p>Special explode (2d6 E, 20 ft.)</p>" });
    assert.equal(s.distance, 20);
});
test("blast with no area uses the range increment", () => {
    const s = areaSpec({ properties: { blast: { value: true } }, area: { shape: "", value: "" }, range: { units: "ft", value: "20" } });
    assert.deepEqual(s, { kind: "blast", t: "cone", distance: 20 });
});
test("blast with a cone area uses it", () => {
    const s = areaSpec({ properties: { blast: { value: true } }, area: { shape: "cone", units: "", value: "15" }, range: { units: "none" } });
    assert.equal(s.distance, 15);
});
test("line uses the range increment", () => {
    const s = areaSpec({ properties: { line: { value: true } }, area: {}, range: { units: "ft", value: "60" } });
    assert.deepEqual(s, { kind: "line", t: "ray", distance: 60 });
});
test("automatic only in auto mode", () => {
    const sys = { properties: { automatic: { value: true } }, area: {}, range: { units: "ft", value: "60" } };
    assert.equal(areaSpec(sys), null);
    assert.deepEqual(areaSpec(sys, { autoMode: true }), { kind: "automatic", t: "cone", distance: 30 });
});
test("automatic half increment rounds to 5 ft", () => {
    const s = areaSpec({ properties: { automatic: { value: true } }, area: {}, range: { units: "ft", value: "25" } }, { autoMode: true });
    assert.equal(s.distance, 10);
});
test("spell sphere 20", () => {
    const s = areaSpec({ area: { shape: "sphere", units: "ft", value: "20" } });
    assert.deepEqual(s, { kind: "area", t: "circle", distance: 20 });
});
test("cone breath 30", () => assert.equal(areaSpec({ area: { shape: "cone", units: "ft", value: "30" } }).t, "cone"));
test("no area", () => assert.equal(areaSpec({ area: { shape: "", value: "" } }), null));

// DCs stripped from text players can see
test("strip button text", () => assert.equal(stripDCs("Save DC 15 Reflex half"), "Save Reflex half"));
test("strip item name", () => assert.equal(stripDCs("Crush Skull (DC 25)"), "Crush Skull"));
test("leave other text", () => assert.equal(stripDCs("Reflex half"), "Reflex half"));

// v0.2.1: damage parts and immunities
const T = (t) => ({ acid: false, fire: false, bludgeoning: false, healing: false, ...t });
test("Strength damage part", () => assert.equal(isAbilityDamagePart({ name: "Strength damage", types: T({}) }), true));
test("Dexterity drain part", () => assert.equal(isAbilityDamagePart({ name: "Dexterity drain", types: {} }), true));
test("plain Damage part isn't ability damage", () => assert.equal(isAbilityDamagePart({ name: "Damage", types: {} }), false));
test("typed part named for an ability isn't", () => assert.equal(isAbilityDamagePart({ name: "Strength damage", types: T({ fire: true }) }), false));
test("healing part", () => assert.equal(isHealingPart({ types: T({ healing: true }) }), true));
test("fire part isn't healing", () => assert.equal(isHealingPart({ types: T({ fire: true }) }), false));
test("part name from name", () => assert.equal(partName({ name: "Piercing", formula: "1d6" }, 1), "Piercing"));
test("part name from types and formula", () => assert.equal(partName({ name: "", formula: "1d4+1", types: T({ fire: true }) }, 0), "fire 1d4+1"));
test("part name, untyped", () => assert.equal(partName({ name: "", formula: "1d4+1", types: T({}) }, 2), "1d4+1"));
test("part name, long formula", () => assert.equal(partName({ name: "", formula: "lookupRange(@item.level, 2, 2, 4, 3)d10", types: T({}) }, 0), "Part 1"));
test("undead are mind-immune", () => assert.equal(mindImmune({ type: "Undead" }), true));
test("constructs are mind-immune", () => assert.equal(mindImmune({ type: "Construct (technological)" }), true));
test("immunity text", () => assert.equal(mindImmune({ type: "", ciCustom: "Undead Immunities" }), true));
test("humanoid isn't", () => assert.equal(mindImmune({ type: "Humanoid (goblinoid)", ciCustom: "" }), false));

// Layer 3: conditions from sfrpg's data
const one = (t) => parseEffectText(t);
test("flash grenade flavor", () => assert.deepEqual(one("blinded [[1d4]] rounds"), [{ cond: "blinded", dur: { formula: "1d4", unit: "round" }, amount: null }]));
test("screamer flavor, minutes", () => assert.deepEqual(one("deafened [[1d4]] minutes")[0].dur, { formula: "1d4", unit: "minute" }));
test("cryo flavor", () => assert.deepEqual(one("staggered 1 round")[0].dur, { formula: "1", unit: "round" }));
test("incendiary flavor is burning with damage", () => assert.deepEqual(one("burning 1d4"), [{ cond: "burning", dur: null, amount: "1d4" }]));
test("riot: staggered gets 1 round", () => assert.deepEqual(effectsFromItem({ chatFlavor: "staggered" }).list[0].dur, { formula: "1", unit: "round", assumed: true }));
test("stickybomb description", () => assert.deepEqual(effectsFromItem({ description: "A stickybomb grenade detonates. @UUID[Compendium.sfrpg.conditions.Item.nFBcsp5FS1Wi46Fc]{Entangled} [[/r 2d4]]{2d4 rounds}" }).list, [{ cond: "entangled", dur: { formula: "2d4", unit: "round" }, amount: null }]));
test("two conditions", () => assert.deepEqual(one("nauseated and sickened 1d4 rounds").map(e => e.cond), ["nauseated", "sickened"]));
test("dead and broken aren't inflicted", () => assert.deepEqual(one("dead, broken"), []));
test("off-kilter keeps its hyphen", () => assert.equal(one("off-kilter for 2 rounds")[0].cond, "off-kilter"));
test("flat-footed isn't footed", () => assert.deepEqual(one("flat-footed").map(e => e.cond), ["flat-footed"]));
test("spell links", () => assert.deepEqual(linkedConditions("is @UUID[Compendium.sfrpg.conditions.Item.2X]{Dazed} (unable) and @UUID[Compendium.sfrpg.conditions.Item.2X]{Dazed}"), ["dazed"]));
test("daze uses its duration", () => assert.deepEqual(effectsFromItem({ description: "is @UUID[Compendium.sfrpg.conditions.Item.2X]{Dazed} (unable to act)", spellDuration: { formula: "1", unit: "round" } }).list[0].dur, { formula: "1", unit: "round" }));
test("hold person resave", () => assert.equal(effectsFromItem({ description: "becomes @UUID[Compendium.sfrpg.conditions.Item.N]{Paralyzed}. Each round on its turn, the target can attempt a new saving throw" }).resave, true));
test("no links, no effects", () => assert.equal(effectsFromItem({ description: "You cause all targets to lose proficiency" }).list.length, 0));
test("duration field", () => assert.deepEqual(spellDurationField({ units: "round", value: "@details.cl.value" }), { formula: "@details.cl.value", unit: "round" }));
test("instantaneous isn't a duration", () => assert.equal(spellDurationField({ units: "instantaneous", value: "" }), null));
test("new save text", () => assert.equal(allowsNewSave("no save here"), false));

// Layer 3: critical hit effects (CRB 182-183, Armory 26)
const pc = (t) => parseCrit(t).map(e => [e.key, e.amount]);
test("burn 1d6", () => assert.deepEqual(pc("Burn 1d6"), [["burn", "1d6"]]));
test("arc and knockdown", () => assert.deepEqual(pc("Arc 1d6, knockdown"), [["arc", "1d6"], ["knockdown", null]]));
test("push distance", () => assert.deepEqual(pc("Push (5 ft.)"), [["push", "5 ft"]]));
test("injection", () => assert.deepEqual(pc("Injection DC +2"), [["injection dc", "2"]]));
test("staggared typo", () => assert.deepEqual(pc("staggared"), [["staggered", null]]));
test("severe wound", () => assert.deepEqual(pc("Severe wound"), [["severe wound", null]]));
test("second arc", () => assert.deepEqual(pc("Second arc 1d6"), [["second arc", "1d6"]]));
test("unknown effect", () => assert.equal(parseCrit("Digitize 1d6")[0].key, "unknown"));
test("empty crit", () => assert.deepEqual(parseCrit("—"), []));
test("crit DC", () => assert.equal(critSaveDC(5, 3, -2), 13));
test("undead immune to stun", () => assert.equal(immuneTo({ type: "Undead" }, "stun"), true));
test("construct immune to bleed", () => assert.equal(immuneTo({ type: "Construct (technological)" }, "bleed"), true));
test("humanoid not immune", () => assert.equal(immuneTo({ type: "Humanoid (vesk)" }, "stun"), false));
test("ci list", () => assert.equal(immuneTo({ ci: ["blinded"] }, "blinded"), true));
test("minutes to rounds", () => assert.equal(roundsIn(2, "minute"), 20));
test("due at the origin's turn", () => assert.equal(isDue({ round: 3, turn: 2 }, { round: 3, turn: 2 }), true));
test("not due before it", () => assert.equal(isDue({ round: 3, turn: 2 }, { round: 3, turn: 1 }), false));
test("due in a later round", () => assert.equal(isDue({ round: 3, turn: 2 }, { round: 4, turn: 0 }), true));
test("duration label", () => assert.equal(durationLabel(1, "round"), "1 round"));

// NPC ammunition (0.5.0)
const PW = [{ name: "Zero pistol, frostbite-class" }, { name: "Zero rifle, hailstorm-class" }, { name: "Arc caster, static" }, { name: "Laser pistol, azimuth" }];
const AM = [
    { name: "Battery", ammunitionType: "charge", useCapacity: true, capacityMax: 20, level: 1, quantity: 1 },
    { name: "Battery, High-Capacity", ammunitionType: "charge", useCapacity: true, capacityMax: 40, level: 4, quantity: 1 },
    { name: "Kishalee Battery, High-Capacity", ammunitionType: "charge", useCapacity: true, capacityMax: 40, level: 6, quantity: 1 },
    { name: "Battery, Ultra-Capacity", ammunitionType: "charge", useCapacity: true, capacityMax: 100, level: 5, quantity: 1 },
    { name: "Rounds, Small Arm", ammunitionType: "roundS", useCapacity: false, capacityMax: 0, level: 1, quantity: 30 },
    { name: "Explosive, Rounds, Small Arms", ammunitionType: "roundS", useCapacity: false, capacityMax: 0, level: 2, quantity: 30 },
    { name: "Tactical missile", ammunitionType: "missile", useCapacity: false, capacityMax: 0, level: 10, quantity: 1 },
    { name: "Advanced missile", ammunitionType: "missile", useCapacity: false, capacityMax: 0, level: 13, quantity: 1 }
];
test("norm drops parentheticals", () => assert.equal(norm("Arc caster, static (plus First Arc 1d6)"), "arccasterstatic"));
test("weapon exact", () => assert.equal(matchWeapon("Laser pistol, azimuth", PW).name, "Laser pistol, azimuth"));
test("weapon with prefix", () => assert.equal(matchWeapon("Underwater Zero Pistol, Frostbite-Class", PW).name, "Zero pistol, frostbite-class"));
test("weapon with missing hyphen", () => assert.equal(matchWeapon("Zero rifle, hailstorm class", PW).name, "Zero rifle, hailstorm-class"));
test("weapon with note", () => assert.equal(matchWeapon("Arc caster, static (plus First Arc 1d6)", PW).name, "Arc caster, static"));
test("weapon unknown", () => assert.equal(matchWeapon("Trailblazer Tactical Semi-Auto Pistol", PW), null));
test("integrated by name", () => assert.equal(isIntegrated("Integrated Laser Rifle, aphelion"), true));
test("integrated by feat", () => assert.equal(isIntegrated("Zero rifle", ["Integrated Weapons (Ex)"]), true));
test("integrated tools aren't weapons", () => assert.equal(isIntegrated("Zero rifle", ["Integrated Tools (Ex)"]), false));
test("battery for 20", () => assert.equal(pickAmmo("charge", 20, AM).name, "Battery"));
test("battery for 40", () => assert.equal(pickAmmo("charge", 40, AM).name, "Battery, High-Capacity"));
test("battery for 100", () => assert.equal(pickAmmo("charge", 100, AM).name, "Battery, Ultra-Capacity"));
test("no battery fits 10", () => assert.equal(pickAmmo("charge", 10, AM), null));
test("plain rounds", () => assert.equal(pickAmmo("roundS", 9, AM).name, "Rounds, Small Arm"));
test("tactical missile", () => assert.equal(pickAmmo("missile", 1, AM).name, "Tactical missile"));
test("pack of size 40", () => assert.equal(packOfSize("charge", 40, AM).name, "Battery, High-Capacity"));
test("spare loads", () => assert.deepEqual(["smallA", "longA", "sniper", "heavy", "advancedM"].map(defaultSpareLoads), [2, 2, 2, 1, 1]));
test("goods: batteries", () => assert.deepEqual(parseGoodsAmmo("2 High-Capacity Batteries (40 Charges Each", 1), { type: "charge", size: 40, count: 2 }));
test("goods: battery standard", () => assert.deepEqual(parseGoodsAmmo("Battery, Standard", 1), { type: "charge", size: 20, count: 1 }));
test("goods: 1 battery (20 charges)", () => assert.deepEqual(parseGoodsAmmo("1 Battery (20 Charges)", 1), { type: "charge", size: 20, count: 1 }));
test("goods: magazines", () => assert.deepEqual(parseGoodsAmmo("4 Magazines (100 Longarm Rounds", 1), { type: "roundL", rounds: 100 }));
test("goods: sniper rounds", () => assert.deepEqual(parseGoodsAmmo("10 Sniper Rounds", 1), { type: "roundL", rounds: 10 }));
test("goods: long-arm", () => assert.deepEqual(parseGoodsAmmo("24 Long-arm Rounds", 1), { type: "roundL", rounds: 24 }));
test("goods: plain rounds", () => assert.deepEqual(parseGoodsAmmo("15 Rounds", 1), { type: null, rounds: 15 }));
test("goods: a box", () => assert.deepEqual(parseGoodsAmmo("Rounds, Small Arm", 2), { type: "roundS", rounds: null, packs: 2 }));
test("goods: a count of rounds", () => assert.deepEqual(parseGoodsAmmo("Rounds, Longarm and Sniper", 400), { type: "roundL", rounds: 400 }));
test("goods: not ammo", () => assert.equal(parseGoodsAmmo("Credstick (500 credits)", 1), null));
test("spare battery fits", () => assert.equal(spareFits({ ammunitionType: "charge", useCapacity: true, current: 20, capacityMax: 20 }, { ammunitionType: "charge", current: 0, capacityMax: 20 }), true));
test("spare battery too big", () => assert.equal(spareFits({ ammunitionType: "charge", useCapacity: true, current: 40, capacityMax: 40 }, { ammunitionType: "charge", current: 0, capacityMax: 20 }), false));
test("spent battery isn't a spare", () => assert.equal(spareFits({ ammunitionType: "charge", useCapacity: true, current: 0, capacityMax: 20 }, { ammunitionType: "charge", current: 0, capacityMax: 20 }), false));
test("rounds of another type", () => assert.equal(spareFits({ ammunitionType: "roundL", useCapacity: false, current: 25 }, { ammunitionType: "roundS", current: 0, capacityMax: 9 }), false));

console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
