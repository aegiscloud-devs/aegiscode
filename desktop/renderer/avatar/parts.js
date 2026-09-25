'use strict';

/**
 * parts.js — the layered SVG part manifest (PLAN Phase 22).
 *
 * `lib/avatar/persona.js` says it plainly: "Ids only — geometry lives in
 * `renderer/avatar/` (Phase 22), which reads these same ids." This is that
 * geometry, and the sentence above is enforced rather than trusted: `IDS` below
 * IS `persona.PARTS`, read from the shared module — this file declares no id
 * list of its own. Adding `hair: 'mohawk-9'` to the persona schema whose
 * geometry is missing therefore fails `desktop/test/avatar-render.test.mjs`
 * (which asserts the manifest covers every id, both directions), instead of
 * rendering a bald head the user cannot explain.
 *
 * Everything here is DATA. There is no branch on a part id anywhere in the
 * renderer: the assembler walks `LAYERS` in order and emits whatever shapes the
 * manifest holds, so a commissioned art pack or a seasonal outfit is a file,
 * not a fork. That is the whole point of the phase (docs/avatar-plan.md §3:
 * "the avatar is data, not art").
 *
 * Two deliberate limits, stated here rather than discovered later:
 *
 *   - **Flat vector only.** No WebGL, no sprite atlas, no per-frame work. The
 *     motion in §6 of the plan is CSS transforms on the groups this manifest
 *     produces, and it is off under `prefers-reduced-motion`.
 *   - **No text in the SVG.** Nothing the user typed (name, pronouns, address)
 *     is ever placed inside the markup, so there is no string to escape and no
 *     injection surface in the assembled string. The persona's identity text
 *     reaches the screen through the HUD's *text* readout, where it belongs.
 *
 * Dual-environment on purpose: the renderer loads this with a `<script>` tag
 * (classic script, publishes `AegisAvatarParts`), and the Node tests `require()`
 * it. The shared modules it reads (`persona.js`, `events.js`) are loaded the
 * same way — see index.html and the UMD tail of each.
 */

// The shared pure modules. In the browser they are separate <script> tags that
// publish globals; in Node (tests) they are required. Never forked: the id list
// and the state machine the engine uses are the ones the renderer draws.
const shared = typeof window !== 'undefined' && window.AegisAvatarPersona
  ? { persona: window.AegisAvatarPersona, events: window.AegisAvatarEvents }
  : typeof module !== 'undefined' && module.exports
    ? {
        persona: require('../../lib/avatar/persona.js'),
        events: require('../../lib/avatar/events.js'),
      }
    : { persona: null, events: null };

const PERSONA = shared.persona;
const EVENTS = shared.events;

/** Draw order, back to front. An outfit layer is an "under" or "over" group. */
const LAYERS = Object.freeze([
  'shadow',
  'hairBack',
  'body',
  'outfitUnder',
  'head',
  'face',
  'hairFront',
  'outfitOver',
  'accessory',
  'effect',
]);

/** Six skin tones, light to deep. Index = `presentation.skin` (0–5). */
const SKIN_TONES = Object.freeze(['#f7dcc9', '#eec2a4', '#dda57f', '#c0835a', '#8e5c3c', '#5f3c28']);

/**
 * Palettes. Roles, not literals: a part asks for `cloth` and the palette that
 * the persona selected answers. That is what lets the same geometry render in
 * six moods, and what makes a new palette a six-key object rather than a
 * re-drawing of every part.
 */
const PALETTES = Object.freeze({
  amber: Object.freeze({ bg: '#241a12', ink: '#f6e6d2', accent: '#f0a83c', cloth: '#3d2c1e', clothShade: '#2a1d13', metal: '#c9a227' }),
  slate: Object.freeze({ bg: '#14181f', ink: '#e6ecf5', accent: '#6fa8dc', cloth: '#26313f', clothShade: '#1a222c', metal: '#9fb3c8' }),
  moss: Object.freeze({ bg: '#121a14', ink: '#e8f2e6', accent: '#7fbf7f', cloth: '#243329', clothShade: '#19241d', metal: '#a8bf8f' }),
  plum: Object.freeze({ bg: '#1c1220', ink: '#f1e6f5', accent: '#b27ad6', cloth: '#33203d', clothShade: '#24162c', metal: '#d8b4e2' }),
  mono: Object.freeze({ bg: '#131313', ink: '#f2f2f2', accent: '#bfbfbf', cloth: '#2b2b2b', clothShade: '#1d1d1d', metal: '#9a9a9a' }),
  sunset: Object.freeze({ bg: '#2a1418', ink: '#ffeede', accent: '#ff7a59', cloth: '#472029', clothShade: '#311519', metal: '#ffb27a' }),
});

/** Frames = the head silhouette. Ears are per-frame because the jaw moves. */
const FRAMES = Object.freeze({
  A: Object.freeze({
    label: 'Round',
    head: 'M100 34 C133 34 153 58 153 93 C153 130 130 165 100 173 C70 165 47 130 47 93 C47 58 67 34 100 34 Z',
    ear: Object.freeze([Object.freeze({ cx: 47, cy: 100, r: 11 }), Object.freeze({ cx: 153, cy: 100, r: 11 })]),
    faceY: 104,
  }),
  B: Object.freeze({
    label: 'Square',
    head: 'M100 32 H141 Q155 32 155 62 V98 Q155 148 100 170 Q45 148 45 98 V62 Q45 32 59 32 Z',
    ear: Object.freeze([Object.freeze({ cx: 45, cy: 98, r: 10 }), Object.freeze({ cx: 155, cy: 98, r: 10 })]),
    faceY: 102,
  }),
  C: Object.freeze({
    label: 'Oval',
    head: 'M100 28 C129 28 147 52 147 90 C147 124 129 168 100 180 C71 168 53 124 53 90 C53 52 71 28 100 28 Z',
    ear: Object.freeze([Object.freeze({ cx: 53, cy: 96, r: 9 }), Object.freeze({ cx: 147, cy: 96, r: 9 })]),
    faceY: 106,
  }),
});

/** The neck + torso every persona has, under whatever they are wearing. */
const BODY = Object.freeze({
  neck: 'M85 158 h30 v26 h-30 Z',
  shirt: 'M58 190 Q100 176 142 190 V262 H58 Z',
  sleeveL: 'M58 190 L38 226 L58 238 L74 206 Z',
  sleeveR: 'M142 190 L162 226 L142 238 L126 206 Z',
});

const HAIR = Object.freeze({
  'short-1': Object.freeze({
    label: 'Short',
    back: Object.freeze([]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 28 C131 28 153 50 153 84 C144 62 124 54 100 54 C76 54 56 62 47 84 C47 50 69 28 100 28 Z' }),
      Object.freeze({ kind: 'path', d: 'M62 62 Q86 46 108 56 Q88 60 74 74 Z' }),
    ]),
  }),
  'bob-2': Object.freeze({
    label: 'Bob',
    back: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M44 96 Q44 30 100 30 Q156 30 156 96 V150 Q140 146 138 118 V96 Q132 62 100 62 Q68 62 62 96 V118 Q60 146 44 150 Z' }),
    ]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 26 C133 26 156 52 156 90 Q140 60 100 60 Q60 60 44 90 C44 52 67 26 100 26 Z' }),
      Object.freeze({ kind: 'path', d: 'M46 88 Q60 108 58 150 L44 150 Q42 110 46 88 Z' }),
      Object.freeze({ kind: 'path', d: 'M154 88 Q140 108 142 150 L156 150 Q158 110 154 88 Z' }),
    ]),
  }),
  'long-3': Object.freeze({
    label: 'Long',
    back: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M40 100 Q40 28 100 28 Q160 28 160 100 V226 Q142 232 138 200 V104 Q132 60 100 60 Q68 60 62 104 V200 Q58 232 40 226 Z' }),
    ]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 26 C134 26 158 52 158 92 Q140 58 100 58 Q60 58 42 92 C42 52 66 26 100 26 Z' }),
      Object.freeze({ kind: 'path', d: 'M52 88 Q64 120 62 170 L48 168 Q44 116 52 88 Z' }),
      Object.freeze({ kind: 'path', d: 'M148 88 Q136 120 138 170 L152 168 Q156 116 148 88 Z' }),
    ]),
  }),
  'curly-4': Object.freeze({
    label: 'Curly',
    back: Object.freeze([
      Object.freeze({ kind: 'circle', cx: 62, cy: 66, r: 26 }),
      Object.freeze({ kind: 'circle', cx: 100, cy: 46, r: 30 }),
      Object.freeze({ kind: 'circle', cx: 138, cy: 66, r: 26 }),
    ]),
    front: Object.freeze([
      Object.freeze({ kind: 'circle', cx: 76, cy: 52, r: 20 }),
      Object.freeze({ kind: 'circle', cx: 106, cy: 44, r: 22 }),
      Object.freeze({ kind: 'circle', cx: 134, cy: 58, r: 18 }),
    ]),
  }),
  'buzz-5': Object.freeze({
    label: 'Buzz',
    back: Object.freeze([]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 30 C130 30 152 52 152 82 Q136 58 100 58 Q64 58 48 82 C48 52 70 30 100 30 Z' }),
    ]),
  }),
  'ponytail-6': Object.freeze({
    label: 'Ponytail',
    back: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M146 74 Q186 96 178 148 Q170 190 150 196 Q166 156 158 122 Q150 92 138 82 Z' }),
    ]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 28 C132 28 154 50 154 86 Q140 58 100 58 Q60 58 46 86 C46 50 68 28 100 28 Z' }),
    ]),
  }),
  'braids-7': Object.freeze({
    label: 'Braids',
    back: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M52 92 Q44 150 48 196 L70 196 Q60 150 64 100 Z' }),
      Object.freeze({ kind: 'path', d: 'M148 92 Q156 150 152 196 L130 196 Q140 150 136 100 Z' }),
    ]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 28 C132 28 154 50 154 86 Q140 58 100 58 Q60 58 46 86 C46 50 68 28 100 28 Z' }),
    ]),
    detail: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M50 132 H70 M50 160 H70 M130 132 H150 M130 160 H150', stroke: true, role: 'hairShade' }),
    ]),
  }),
  'wavy-8': Object.freeze({
    label: 'Wavy',
    back: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M42 96 Q42 30 100 30 Q158 30 158 96 Q150 130 156 168 Q146 158 142 132 Q140 96 132 70 Q118 58 100 58 Q82 58 68 70 Q60 96 58 132 Q54 158 44 168 Q50 130 42 96 Z' }),
    ]),
    front: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M100 26 C134 26 158 54 156 94 Q146 62 116 58 Q96 56 84 66 Q66 74 44 94 C42 54 66 26 100 26 Z' }),
    ]),
  }),
});

/** Eye shapes. `expression` may replace the lids (see EXPRESSIONS below). */
const EYES = Object.freeze({
  soft: Object.freeze({
    label: 'Soft',
    left: Object.freeze([Object.freeze({ kind: 'ellipse', cx: 78, cy: 106, rx: 12, ry: 9 }), Object.freeze({ kind: 'circle', cx: 78, cy: 106, r: 5, role: 'ink' }), Object.freeze({ kind: 'circle', cx: 80, cy: 103, r: 2, role: 'highlight' })]),
    right: Object.freeze([Object.freeze({ kind: 'ellipse', cx: 122, cy: 106, rx: 12, ry: 9 }), Object.freeze({ kind: 'circle', cx: 122, cy: 106, r: 5, role: 'ink' }), Object.freeze({ kind: 'circle', cx: 124, cy: 103, r: 2, role: 'highlight' })]),
  }),
  sharp: Object.freeze({
    label: 'Sharp',
    left: Object.freeze([Object.freeze({ kind: 'path', d: 'M66 106 Q78 94 90 106 Q78 112 66 106 Z' }), Object.freeze({ kind: 'circle', cx: 79, cy: 104, r: 4, role: 'ink' })]),
    right: Object.freeze([Object.freeze({ kind: 'path', d: 'M110 106 Q122 94 134 106 Q122 112 110 106 Z' }), Object.freeze({ kind: 'circle', cx: 121, cy: 104, r: 4, role: 'ink' })]),
  }),
  sleepy: Object.freeze({
    label: 'Sleepy',
    left: Object.freeze([Object.freeze({ kind: 'path', d: 'M66 106 Q78 112 90 106', stroke: true }), Object.freeze({ kind: 'circle', cx: 78, cy: 109, r: 3, role: 'ink' })]),
    right: Object.freeze([Object.freeze({ kind: 'path', d: 'M110 106 Q122 112 134 106', stroke: true }), Object.freeze({ kind: 'circle', cx: 122, cy: 109, r: 3, role: 'ink' })]),
  }),
  bright: Object.freeze({
    label: 'Bright',
    left: Object.freeze([Object.freeze({ kind: 'circle', cx: 78, cy: 105, r: 12 }), Object.freeze({ kind: 'circle', cx: 78, cy: 105, r: 6, role: 'ink' }), Object.freeze({ kind: 'circle', cx: 82, cy: 100, r: 3, role: 'highlight' })]),
    right: Object.freeze([Object.freeze({ kind: 'circle', cx: 122, cy: 105, r: 12 }), Object.freeze({ kind: 'circle', cx: 122, cy: 105, r: 6, role: 'ink' }), Object.freeze({ kind: 'circle', cx: 126, cy: 100, r: 3, role: 'highlight' })]),
  }),
});

/** Everything that is always on the face regardless of expression. */
const FACE = Object.freeze({
  nose: Object.freeze([Object.freeze({ kind: 'path', d: 'M100 116 Q104 124 98 128', stroke: true })]),
});

/**
 * Expressions. The seven core ones are exactly `events.js`'s `EXPRESSIONS`
 * values — asserted by test, so a new engine state cannot silently render a
 * face nobody drew. The named packs after them are cosmetic additions; the
 * *state machine never selects them*, they exist for the customization pane and
 * for `persona.expressions.custom`, which may reference these atoms by name.
 */
const EXPRESSIONS = Object.freeze({
  neutral: Object.freeze({ label: 'Neutral', brows: Object.freeze(['M64 92 Q78 86 90 92', 'M110 92 Q122 86 136 92']), mouth: 'M88 140 Q100 146 112 140' }),
  attentive: Object.freeze({ label: 'Attentive', brows: Object.freeze(['M64 88 Q78 80 90 88', 'M110 88 Q122 80 136 88']), mouth: 'M88 140 Q100 148 112 140' }),
  focused: Object.freeze({ label: 'Focused', brows: Object.freeze(['M64 90 Q78 84 90 96', 'M110 96 Q122 84 136 90']), mouth: 'M88 142 H112' }),
  waiting: Object.freeze({ label: 'Waiting', brows: Object.freeze(['M62 86 Q78 78 92 84', 'M108 84 Q122 78 138 86']), mouth: 'M90 142 Q100 138 110 142' }),
  happy: Object.freeze({ label: 'Happy', brows: Object.freeze(['M64 88 Q78 82 90 88', 'M110 88 Q122 82 136 88']), mouth: 'M84 138 Q100 156 116 138', eyes: 'arc' }),
  sleepy: Object.freeze({ label: 'Sleepy', brows: Object.freeze(['M64 94 Q78 90 90 94', 'M110 94 Q122 90 136 94']), mouth: 'M92 144 Q100 150 108 144', eyes: 'closed' }),
  concerned: Object.freeze({ label: 'Concerned', brows: Object.freeze(['M62 84 Q78 92 92 98', 'M108 98 Q122 92 138 84']), mouth: 'M88 146 Q100 138 112 146' }),
  warm: Object.freeze({ label: 'Warm', brows: Object.freeze(['M64 90 Q78 84 90 90', 'M110 90 Q122 84 136 90']), mouth: 'M86 138 Q100 152 114 138' }),
  proud: Object.freeze({ label: 'Proud', brows: Object.freeze(['M64 86 Q78 80 90 86', 'M110 86 Q122 80 136 86']), mouth: 'M88 138 Q104 150 112 138' }),
  playful: Object.freeze({ label: 'Playful', brows: Object.freeze(['M64 88 Q78 80 90 88', 'M110 88 Q122 80 136 88']), mouth: 'M84 138 Q100 158 116 138', eyes: 'arc' }),
  curious: Object.freeze({ label: 'Curious', brows: Object.freeze(['M64 82 Q78 76 90 88', 'M110 88 Q122 76 136 82']), mouth: 'M94 142 Q100 148 106 142' }),
  steady: Object.freeze({ label: 'Steady', brows: Object.freeze(['M64 90 Q78 86 90 90', 'M110 90 Q122 86 136 90']), mouth: 'M90 141 Q100 145 110 141' }),
  delighted: Object.freeze({ label: 'Delighted', brows: Object.freeze(['M62 86 Q78 78 92 86', 'M108 86 Q122 78 138 86']), mouth: 'M82 136 Q100 160 118 136', eyes: 'arc' }),
  reverent: Object.freeze({ label: 'Reverent', brows: Object.freeze(['M64 94 Q78 88 90 94', 'M110 94 Q122 88 136 94']), mouth: 'M90 140 Q100 144 110 140', eyes: 'closed' }),
  weary: Object.freeze({ label: 'Weary', brows: Object.freeze(['M62 92 Q78 96 92 100', 'M108 100 Q122 96 138 92']), mouth: 'M88 146 Q100 142 112 146' }),
});

/** Which pack adds which ids. `core` is the base every persona has. */
const EXPRESSION_PACKS = Object.freeze({
  core: Object.freeze(['neutral', 'attentive', 'focused', 'waiting', 'happy', 'sleepy', 'concerned']),
  trusted: Object.freeze(['warm', 'proud']),
  companion: Object.freeze(['playful', 'curious']),
  confidant: Object.freeze(['steady', 'delighted']),
  archivist: Object.freeze(['reverent', 'weary']),
});

/** Eye replacements an expression may request. */
const EYE_OVERRIDES = Object.freeze({
  arc: Object.freeze([
    Object.freeze({ kind: 'path', d: 'M66 108 Q78 96 90 108', role: 'ink' }),
    Object.freeze({ kind: 'path', d: 'M110 108 Q122 96 134 108', role: 'ink' }),
  ]),
  closed: Object.freeze([
    Object.freeze({ kind: 'path', d: 'M66 106 H90', role: 'ink' }),
    Object.freeze({ kind: 'path', d: 'M110 106 H134', role: 'ink' }),
  ]),
});

/** Outfits: an `under` group (drawn behind the head) and an `over` group. */
const OUTFITS = Object.freeze({
  hoodie: Object.freeze({
    label: 'Hoodie',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M56 192 Q100 174 144 192 V262 H56 Z' }),
      Object.freeze({ kind: 'path', d: 'M78 178 Q100 196 122 178 L134 190 Q100 212 66 190 Z', role: 'clothShade' }),
      Object.freeze({ kind: 'path', d: 'M74 214 H126 V240 H74 Z', role: 'clothShade' }),
      Object.freeze({ kind: 'path', d: 'M96 196 V214 M104 196 V214', role: 'metal' }),
    ]),
  }),
  tshirt: Object.freeze({
    label: 'T-shirt',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M56 192 Q100 176 144 192 V262 H56 Z', role: 'accent' }),
      Object.freeze({ kind: 'path', d: 'M84 182 Q100 194 116 182 L120 188 Q100 200 80 188 Z', role: 'clothShade' }),
    ]),
  }),
  flannel: Object.freeze({
    label: 'Flannel',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M56 192 Q100 176 144 192 V262 H56 Z' }),
      Object.freeze({ kind: 'path', d: 'M70 196 V262 M88 194 V262 M112 194 V262 M130 196 V262', role: 'clothShade' }),
      Object.freeze({ kind: 'path', d: 'M56 214 H144 M56 236 H144', role: 'accent' }),
      Object.freeze({ kind: 'path', d: 'M84 182 L100 200 L116 182 L124 190 L100 214 L76 190 Z', role: 'clothShade' }),
    ]),
  }),
  jacket: Object.freeze({
    label: 'Jacket',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M54 190 Q100 172 146 190 V262 H54 Z' }),
      Object.freeze({ kind: 'path', d: 'M54 190 L100 214 L146 190 L146 200 L100 224 L54 200 Z', role: 'clothShade' }),
      Object.freeze({ kind: 'path', d: 'M100 214 V262', role: 'metal' }),
    ]),
  }),
  headphones: Object.freeze({
    label: 'Headphones',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M46 96 Q46 30 100 30 Q154 30 154 96', role: 'metal' }),
      Object.freeze({ kind: 'rect', x: 34, y: 88, width: 22, height: 34, rx: 8 }),
      Object.freeze({ kind: 'rect', x: 144, y: 88, width: 22, height: 34, rx: 8 }),
      Object.freeze({ kind: 'circle', cx: 45, cy: 105, r: 6, role: 'accent' }),
      Object.freeze({ kind: 'circle', cx: 155, cy: 105, r: 6, role: 'accent' }),
    ]),
    accessory: true,
  }),
  glasses: Object.freeze({
    label: 'Glasses',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'rect', x: 60, y: 96, width: 40, height: 26, rx: 8, role: 'metal' }),
      Object.freeze({ kind: 'rect', x: 100, y: 96, width: 40, height: 26, rx: 8, role: 'metal' }),
      Object.freeze({ kind: 'path', d: 'M100 106 H100 M60 104 L44 100 M140 104 L156 100', role: 'metal' }),
    ]),
    accessory: true,
  }),
  scarf: Object.freeze({
    label: 'Scarf',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M72 172 Q100 190 128 172 L134 190 Q100 208 66 190 Z', role: 'accent' }),
      Object.freeze({ kind: 'path', d: 'M112 190 L128 236 L112 240 L98 194 Z', role: 'accent' }),
    ]),
  }),
  apron: Object.freeze({
    label: 'Apron',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M74 200 H126 V262 H74 Z', role: 'clothShade' }),
      Object.freeze({ kind: 'path', d: 'M80 190 L92 200 M120 190 L108 200', role: 'metal' }),
      Object.freeze({ kind: 'path', d: 'M80 228 H120', role: 'accent' }),
    ]),
  }),
  'seasonal-winter': Object.freeze({
    label: 'Winter set',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M44 74 Q100 44 156 74 L156 88 Q100 60 44 88 Z', role: 'accent' }),
      Object.freeze({ kind: 'circle', cx: 100, cy: 40, r: 12, role: 'accent' }),
      Object.freeze({ kind: 'path', d: 'M72 172 Q100 190 128 172 L134 190 Q100 208 66 190 Z', role: 'clothShade' }),
    ]),
  }),
  'archive-coat': Object.freeze({
    label: 'Archive coat',
    under: Object.freeze([]),
    over: Object.freeze([
      Object.freeze({ kind: 'path', d: 'M50 188 Q100 168 150 188 V262 H50 Z' }),
      Object.freeze({ kind: 'path', d: 'M50 188 L100 216 L150 188 L150 200 L100 228 L50 200 Z', role: 'clothShade' }),
      Object.freeze({ kind: 'path', d: 'M56 222 H144 V234 H56 Z', role: 'metal' }),
      Object.freeze({ kind: 'path', d: 'M100 228 V262', role: 'metal' }),
    ]),
  }),
});

/** Human labels for the pane. A missing label falls back to the raw id. */
const LABELS = Object.freeze({
  frame: Object.freeze({ A: 'Round', B: 'Square', C: 'Oval' }),
  hair: Object.freeze(Object.fromEntries(Object.entries(HAIR).map(([k, v]) => [k, v.label]))),
  eyes: Object.freeze(Object.fromEntries(Object.entries(EYES).map(([k, v]) => [k, v.label]))),
  outfit: Object.freeze(Object.fromEntries(Object.entries(OUTFITS).map(([k, v]) => [k, v.label]))),
  palette: Object.freeze({ amber: 'Amber', slate: 'Slate', moss: 'Moss', plum: 'Plum', mono: 'Mono', sunset: 'Sunset' }),
  expressionPack: Object.freeze({ core: 'Core', trusted: 'Trusted', companion: 'Companion', confidant: 'Confidant', archivist: 'Archivist' }),
  skin: Object.freeze({ 0: 'Tone 1', 1: 'Tone 2', 2: 'Tone 3', 3: 'Tone 4', 4: 'Tone 5', 5: 'Tone 6' }),
});

/** Id lists the assembler validates against — `persona.PARTS`, never a copy. */
const IDS = PERSONA ? PERSONA.PARTS : Object.freeze({});

/** The persona's own defaults, for a renderer that has never seen a file. */
function defaultPersona() {
  if (!PERSONA) throw new Error('avatar/parts.js: the shared persona module is not loaded');
  return PERSONA.defaultPersona();
}

/**
 * Motion policy: `prefers-reduced-motion` is not advisory (persona.js says so,
 * and this defers to the same function rather than re-deciding it).
 */
function motionFor(persona, prefersReducedMotion) {
  if (!PERSONA) return prefersReducedMotion ? 'minimal' : 'full';
  const record = persona && persona.appearance ? persona : defaultPersona();
  return PERSONA.appliesMotion(record, Boolean(prefersReducedMotion));
}

/** The expressions a persona's pack can show (core always included). */
function expressionsFor(persona) {
  const pack = persona && persona.expressions && persona.expressions.pack;
  const extra = EXPRESSION_PACKS[pack] || [];
  const list = EXPRESSION_PACKS.core.slice();
  for (const id of extra) if (!list.includes(id)) list.push(id);
  return list;
}

const API = Object.freeze({
  LAYERS,
  IDS,
  SKIN_TONES,
  PALETTES,
  FRAMES,
  BODY,
  HAIR,
  EYES,
  FACE,
  EXPRESSIONS,
  EXPRESSION_PACKS,
  EYE_OVERRIDES,
  OUTFITS,
  LABELS,
  defaultPersona,
  motionFor,
  expressionsFor,
});

// UMD tail — the file is a classic renderer script AND a Node module. The
// shared persona/events modules are loaded the same way.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof globalThis !== 'undefined') globalThis.AegisAvatarParts = API;
