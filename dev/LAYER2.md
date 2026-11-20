# Layer 2: saves and areas (decided Nov 19, 2026)

Not part of the release zip. The project doc (combat_module.md) is the full record.

## Owen's calls
- **PC saves:** the player rolls. A prompt opens on the owner's screen with their own dice; the GM's client rolls it if they're offline, pick "GM rolls", or don't answer within the timeout (30 s).
- **"Partial" saves with damage:** half on a save, and the GM card flags the row ("partial: check the effect") with Full / Half / None buttons.
- **DCs:** hidden everywhere. Module cards show only Saved or Failed; DCs are stripped from NPC item cards and roll titles before they're posted (players can read message data).
- **Scope:** all three attack-roll area weapons (blast, line, automatic mode) are in layer 2, along with explode weapons and save effects.

## What the module does
- **Save effects** (spells and abilities with a save and damage, and spells stored as attacks when they have an area, like sfrpg's Explosive Blast): the caster rolls damage (sfrpg's Damage button); each target saves; failed = full, saved = half (rounded down, before DR/ER) or none (negates).
- **Damage-only effects** (no attack, no save): full damage to the targets (setting).
- **Explode weapons:** aim at an intersection (AC 5, range penalties); a miss scatters 1d8 direction (1 = toward the thrower, 2-8 clockwise) and 1d4 squares (CRB 245); everyone in the burst saves Reflex for half; the DC is the item's, lowered by the attack's penalties (CRB 181); a natural 20 crits only the creature nearest the intersection (FAQ).
- **Blast:** a d20 per creature in the cone at -2, nearest first; damage rolled once; crit damage once for the crits.
- **Line:** one roll against every creature; only the first can be crit; the line stops at the first creature hit that takes no damage.
- **Automatic mode** (bar toggle "Auto", next attack only): cone at half the range increment; a d20 per creature at -4 (unless Full attack is on); no crits; ammo (two shots per creature) is layer 4.
- **Attack items with a save** (riders): layer 1 resolves the hit, then the save is rolled for each creature hit; damage halves only when the save says half.
- **Targets:** placing a template from an item card targets the tokens in the squares it highlights (sfrpg's own shapes). Area weapons with no template placed open the template preview when they attack.
- **Saves:** natural 1 fails, natural 20 succeeds (CRB 241); bar cover adds +1/+2/+4 to Reflex (CRB 253); total cover = unaffected.
- **Evasion / Improved Evasion:** read by feature name, PCs and NPCs; Reflex-for-half effects only; lost when helpless, paralyzed, pinned, unconscious, stunned, encumbered, overburdened, or (PCs) in heavy or powered armor.
- **Spell resistance:** spells that allow SR roll d20 + caster level against each target's SR; failed = no effect (GM can flip).

## Small fixes folded in
- No GM connected: checked before rolling; plain sfrpg plus a warning.
- Close, medium and long spell ranges use sfrpg's totals (range check and an out-of-range warning for targeted save spells).
- Modal weapons ask for their mode once (bar button "Mode" asks again); double weapons ask each attack.
- Drones (CRB 74): inactive (unconscious) at 0 HP; destroyed by a single attack of at least their maximum HP while at 0.
