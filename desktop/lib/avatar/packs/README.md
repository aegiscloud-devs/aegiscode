# Cosmetics packs

A pack is one JSON file. `cosmetics.js` validates it on load; `store.verifyAtBoot()`
audits the shipped set at launch. Nothing here can do anything — a pack names
looks, and the unlock table in `../level.js` decides whether they are free or
paid.

```
<pack-id>.pack.json
```

| field | required | notes |
|---|---|---|
| `schema` | yes | `1`. A newer pack is rejected, not guessed at. |
| `id` | yes | kebab-case slug, e.g. `seasonal-winter`. |
| `name` | yes | shown in the pane. |
| `kind` | yes | `outfit` \| `expressions` \| `palette` \| `voice`. One pack, one kind. |
| `tier` | yes | `free` \| `paid`. Must agree with the unlock's `paid` flag. |
| `unlocks` | yes | 1–8 ids that must already exist in `../level.js` `UNLOCKS`. |
| `items` | yes | 1–24 items; `id` + `label` (+ `parts` for outfits, `engine` + `consent` for voices). |
| `author`, `license`, `summary` | no | metadata for the pane and the store page. |

## The rule this directory exists to enforce

**Cosmetics only.** Never XP, levels, recall breadth, approval friction or
personalization (`docs/avatar-plan.md` §3, invariant 8). `validatePack` refuses a
pack carrying `xp`, `level`, `recallEntries`, `approvals`, `toolGrants`,
`modelFloor`, `proactivity`, `price`, `entitlement`, … at any depth, and refuses
a `tier` that contradicts the unlock table — so a "paid pack that also widens a
limit" cannot load. `test/avatar-cosmetics.test.mjs` proves each of those refusals
fires; the assertions run the validator on deliberately corrupt packs rather than
trusting the code to be right.

Voice packs additionally must declare `engine: "local" | "system"` and
`consent: "synthetic"`. There is no field for an audio sample, and no voice id
may look like a clone — see `../voice.js`.

## Shipped set

| pack | tier | kind | unlocks |
|---|---|---|---|
| `core-wardrobe` | free | outfit | `outfit.hoodie`, `outfit.tshirt` (L1) |
| `local-voice-core` | free | voice | `voice.core` (L10) |
| `seasonal-winter` | paid | outfit | `outfit.seasonal` (L20) |

The paid row is the whole point of shipping one: the free/paid line is data a
test can read (`cosmetics.freePaidLine()`), not a sentence in a pitch deck.
