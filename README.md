# SFRPG Combat Automation

Combat automation for the Starfinder 1e (sfrpg) system in Foundry VTT, in the spirit of MidiQOL: targeted attacks against EAC/KAC, hit, miss and crit per target, damage rolled on a hit and applied on the GM's client with the system's own DR, energy resistance, immunity, vulnerability, temp HP, Stamina and HP math, then nonlethal and 0 HP. Saves for spells, abilities and grenades (full, half or none per target, Evasion, spell resistance), and area weapons (explode, blast, line, automatic). One card per attack or effect with Undo and flips.

**Status:** v0.2.0 (Nov 19, 2026): layers 1 and 2, tested on Foundry 14.370 with sfrpg 14.0.2. Works on Foundry 13 and 14 (v14 stores templates as Regions; the module handles both).

## Install
Requires **socketlib**. In Foundry's setup screen, Add-on Modules → Install Module, paste the manifest URL:

```
https://github.com/obossrocks-sys/sfrpg-combat-automation/releases/latest/download/module.json
```

Then enable **SFRPG Combat Automation** (and socketlib) in the world. A GM must be connected for players' attacks to be applied.

## How an attack runs
1. The attacker targets one or more tokens and attacks as usual (sheet, Argon HUD, hotbar).
2. On the roller's client, sfrpg's `attackRolled` hook fires. For each target the module picks the AC (the weapon's own setting; with none, kinetic damage targets KAC and energy-only EAC) and calls the result: a natural 1 misses, a natural 20 hits and is a critical only if the total also meets the AC (CRB 240, 245). It adds cover from the bar, prone (+4 AC against ranged, -4 against melee), helpless (+4 to melee attacks) and range (-2 per full increment past the first, -1 with Far Shot; past 10 increments, or 5 thrown, misses). A melee target beyond the attacker's reach gets a warning on the GM card only; the attack still resolves. Reach is the actor's stored reach (a named exception such as "10 ft. with tactical pike" counts for that weapon), at least 10 ft with the reach property, otherwise 5 ft; a 10-ft reach also takes the second square of a diagonal (CRB 255).
3. On a hit, the roller's client rolls damage (normal and/or critical) through `item.rollDamage`, so their dice show.
4. The result goes to the GM's client (socketlib), which applies it per target with `actor.applyDamage` and then: an NPC at 0 HP dies and is marked defeated (unconscious instead if the damage was nonlethal); a PC becomes dying and unconscious (unconscious and stable if nonlethal).
5. Two messages: a public card (Hit, Miss or Critical hit and the damage dealt) and a GM-only whisper with the numbers (roll against AC, cover, prone, range, the DR/ER math, temp/SP/HP before and after) and the buttons: Undo / Reapply, Make hit / Make miss per target, and Apply when auto-apply is off. Undo refunds the amounts that attack dealt, so it stays correct after later attacks on the same target.

sfrpg's own "Targets: KAC 22 - HIT" tag on the attack roll is removed when the module handles the attack (it carries the AC in the page and calls every natural 20 a crit).

## Saves and areas (layer 2)
- **Templates target tokens.** Placing a template from an item card ("Place template") targets every token in the squares it highlights (sfrpg's own Starfinder shapes), on the placer's screen. Shift-click to adjust before rolling.
- **Save effects.** Spells and abilities with a save and damage (including spells stored as attacks when they have an area, like Explosive Blast): target, then roll damage from the card. Each target saves; failed takes full, saved takes half (rounded down, before DR and ER) or none for negates. "Partial" applies half on a save and flags the row on the GM card with Full / Half / None. Natural 1 fails and natural 20 succeeds (CRB 241); cover from the bar adds +1/+2/+4 to Reflex (CRB 253).
- **Who rolls.** NPC saves roll quietly on the GM's client. A PC's player gets a prompt to roll their own save (their dice, in chat); if they're offline, pick "GM rolls" or don't answer within the timeout, the GM's client rolls it. A setting makes the GM's client roll everything.
- **Evasion and Improved Evasion** come from features with those names, for PCs and NPCs, against Reflex-for-half effects; not while helpless, paralyzed, pinned, unconscious, stunned, encumbered or overburdened, or (PCs) in heavy or powered armor.
- **Spell resistance:** spells that allow SR roll d20 + caster level against each target's SR; a failed check means no effect (the GM card can flip it).
- **Explode weapons** (grenades, plasma cannons): the attack aims at an intersection (AC 5, with range penalties). If no template was placed from the card, the preview opens when you attack. A miss scatters it 1d8 for direction (1 toward the thrower, 2-8 clockwise) and 1d4 squares (CRB 245) and moves the template. Everyone in the burst saves Reflex for half; the DC is the item's, lowered by the attack's penalties (CRB 181); a natural 20 crits only the creature nearest the intersection.
- **Blast:** a d20 per creature in the cone at -2, nearest first; damage rolled once; crit damage rolled once for the crits (CRB 180).
- **Line:** one roll against every creature; only the first can be crit; the line stops at the first creature hit that takes no damage (CRB 181).
- **Automatic mode:** press Auto on the bar before the attack: a cone of half the range increment, a d20 per creature at -4 (unless Full attack is on), no crits. Ammo is spent by hand for now.
- **Attack items with a save** (a rider such as "plus inflame"): the hit resolves as usual, then each creature hit rolls the save; damage halves only when the save says half.
- **Damage-only effects** (no attack and no save): full damage to the targets.
- **Hidden DCs:** module cards show Saved or Failed only; DCs are removed from NPC item cards and roll titles before they're posted. The GM card shows the DC and how it was worked out.

## Attack-options bar
A small bar above the hotbar, per user and sticky: Full attack (clears when the turn passes), Flanking, Nonlethal, Fight defensively, Charge, Harrying fire. Each drives one of sfrpg's own global attack modifiers (`CONFIG.SFRPG.globalAttackRollModifiers`, found by `_id`), so the quick roll includes it. Auto turns on automatic mode for the next attack; Mode makes modal weapons ask for their mode again (double weapons ask every attack). Cover (partial, cover, improved, total) applies to the next attack or effect only. GMs also get a Flat-footed button that toggles sfrpg's condition on the targeted tokens.

## Left alone
No targets: plain sfrpg (area weapons open the template preview instead). No GM connected: plain sfrpg, with a warning. Starship and vehicle attacks. Healing. Saves with no damage (conditions are layer 3). sfrpg's right-click apply still works for manual cases.

## The bar (0.2.2)
Drag the grip at its left end to move it anywhere; the spot is saved per user. Double-click the grip to put it back under the hotbar. **Cover picked by the GM applies to the next attack or effect by anyone** (players see "GM: Cover" on their bar); a player's own pick applies to their own next attack. The higher of the two counts.

## Settings
Automate targeted attacks; roll damage on a hit; apply damage automatically (off: the GM card shows Apply); conditions at 0 HP; hide the system's AC tag; **GM sees only the GM card** (hides the public card on GM screens; on by default); clear targets after each attack (off by default since 0.2.2: targets stay until the player changes them); **remove the dead from the combat tracker** (0.2.2; on); range penalties; show the bar (per user). Layer 2: automate saves; area attack weapons; templates target tokens; player saves (prompt or GM) and the prompt timeout; spell resistance checks; damage-only effects hit targets; hide save DCs from players.

## Files
- `module.json`: manifest (requires socketlib).
- `scripts/main.js`: entry; hooks; teardown for reloading in place.
- `scripts/workflow.js`: the roller's side (attackRolled routing, explode, blast/line/automatic, the rollDamage wrapper for save effects, tag and DC stripping).
- `scripts/rules.js`: AC pick, natural d20, cover, prone, helpless, reach, range.
- `scripts/logic.js`: pure rules (saves, shares, Evasion, range, scatter, area shapes), unit-tested.
- `scripts/areas.js`: templates and their items, placement, tokens in an area, scatter.
- `scripts/saves.js`: DCs, who rolls, the player prompt, Evasion, spell resistance.
- `scripts/apply.js`: the GM's side (apply, shares, saves, line stop, riders, nonlethal, 0 HP and drones, undo, flips).
- `scripts/cards.js`: the public card and the GM card, button wiring.
- `scripts/options-bar.js`: the bar.
- `scripts/socket.js`, `scripts/settings.js`, `scripts/constants.js`.
- `styles/sca.css`.
- `dev/test-helpers.js`: helpers for the Test Range scene; `dev/unit-tests.mjs` and `dev/mock-harness.mjs` run in Node (`node dev/unit-tests.mjs`); `dev/LAYER2.md`, the layer 2 decisions (none of `dev/` is in the release zip).

## Prototype loading (development)
In the GM's browser console, with a pushed commit:

```js
const sha = "<commit>";
await import(`https://cdn.jsdelivr.net/gh/obossrocks-sys/sfrpg-combat-automation@${sha}/dev/test-helpers.js`);
await SCA_LOAD(sha);
```

`SCA_LOAD` replaces any copy already loaded, the installed module included, until the page reloads (socketlib hands back the module's existing socket). Players keep running the installed version, so test player paths after a release.

## Releasing
Bump `version` in `module.json`, zip `module.json`, `README.md`, `scripts/` and `styles/` (not `dev/`) as `module.zip`, and attach both `module.json` and `module.zip` to a GitHub release tagged `v<version>`. The manifest and download URLs point at the latest release.
