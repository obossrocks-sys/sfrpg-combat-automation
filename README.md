# SFRPG Combat Automation

Combat automation for the Starfinder 1e (sfrpg) system in Foundry VTT, in the spirit of MidiQOL: targeted attacks against EAC/KAC, hit, miss and crit per target, damage rolled on a hit and applied on the GM's client with the system's own DR, energy resistance, immunity, vulnerability, temp HP, Stamina and HP math, then nonlethal and 0 HP. One card per attack with Undo and flip hit/miss.

**Status:** layer 1 prototype, GM path tested on Foundry 14.370 with sfrpg 14.0.2 (Nov 19, 2026). Not packaged or released yet; the player path (socketlib) is untested.

## How an attack runs
1. The attacker targets one or more tokens and attacks as usual (sheet, Argon HUD, hotbar).
2. On the roller's client, sfrpg's `attackRolled` hook fires. For each target the module picks the AC (the weapon's own setting; with none, kinetic damage targets KAC and energy-only EAC) and calls the result: a natural 1 misses, a natural 20 hits and is a critical only if the total also meets the AC (CRB 240, 245). It adds cover from the bar, prone (+4 AC against ranged, -4 against melee), helpless (+4 to melee attacks) and range (-2 per full increment past the first, -1 with Far Shot; past 10 increments, or 5 thrown, misses).
3. On a hit, the roller's client rolls damage (normal and/or critical) through `item.rollDamage`, so their dice show.
4. The result goes to the GM's client (socketlib), which applies it per target with `actor.applyDamage` and then: an NPC at 0 HP dies and is marked defeated (unconscious instead if the damage was nonlethal); a PC becomes dying and unconscious (unconscious and stable if nonlethal).
5. Two messages: a public card (Hit, Miss or Critical hit and the damage dealt) and a GM-only whisper with the numbers (roll against AC, cover, prone, range, the DR/ER math, temp/SP/HP before and after) and the buttons: Undo / Reapply, Make hit / Make miss per target, and Apply when auto-apply is off. Undo refunds the amounts that attack dealt, so it stays correct after later attacks on the same target.

sfrpg's own "Targets: KAC 22 - HIT" tag on the attack roll is removed when the module handles the attack (it carries the AC in the page and calls every natural 20 a crit).

## Attack-options bar
A small bar above the hotbar, per user and sticky: Full attack (clears when the turn passes), Flanking, Nonlethal, Fight defensively, Charge, Harrying fire. Each drives one of sfrpg's own global attack modifiers (`CONFIG.SFRPG.globalAttackRollModifiers`, found by `_id`), so the quick roll includes it. Cover (partial, cover, improved, total) applies to the next attack only. GMs also get a Flat-footed button that toggles sfrpg's condition on the targeted tokens.

## Left alone
No targets: plain sfrpg. Starship and vehicle attacks. Area and save effects (layer 2). sfrpg's right-click apply still works for manual cases.

## Settings
Automate targeted attacks; roll damage on a hit; apply damage automatically (off: the GM card shows Apply); conditions at 0 HP; hide the system's AC tag; clear targets after each attack; range penalties; show the bar (per user).

## Files
- `module.json`: manifest (requires socketlib).
- `scripts/main.js`: entry; hooks; teardown for reloading in place.
- `scripts/workflow.js`: the roller's side (attackRolled, damage rolls, tag strip).
- `scripts/rules.js`: AC pick, natural d20, cover, prone, helpless, range.
- `scripts/apply.js`: the GM's side (apply, nonlethal, 0 HP, undo, flip).
- `scripts/cards.js`: the public card and the GM card, button wiring.
- `scripts/options-bar.js`: the bar.
- `scripts/socket.js`, `scripts/settings.js`, `scripts/constants.js`.
- `styles/sca.css`.
- `dev/test-helpers.js`: prototype helpers for the Test Range scene (not shipped).

## Prototype loading (development)
In the GM's browser console, with a pushed commit:

```js
const sha = "<commit>";
await import(`https://cdn.jsdelivr.net/gh/obossrocks-sys/sfrpg-combat-automation@${sha}/dev/test-helpers.js`);
await SCA_LOAD(sha);
```

`SCA_LOAD` replaces any copy already loaded. In this mode socketlib isn't registered, so only the GM path works.
