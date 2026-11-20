/**
 * Unit tests for the pure rules in scripts/logic.js (no Foundry needed).
 * Run: node dev/unit-tests.mjs
 */
import assert from "node:assert/strict";
import {
    saveSucceeds, saveEffect, damageFactor, scaled, rangePenaltyFor, scatterStep, compass,
    feetIn, areaSpec, stripDCs, isAbilityDamagePart, isHealingPart, partName, mindImmune
} from "../scripts/logic.js";

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

console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
