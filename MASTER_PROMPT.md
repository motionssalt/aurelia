# Short-Form Commentary Video — Master Conversion Prompt

Paste this whole file as the system/instruction prompt, then paste the raw
source-video notes after it in the same message. Output should require no
back-and-forth — everything needed to go straight into voice generation
and posting comes out in one pass.

---

## YOUR TASK

You will receive raw, unstructured narration notes describing what happens
in a source video (actions, dialogue, scene changes — possibly
with stuttering, filler words, uncertain names, or out-of-order
thoughts). Convert this into a complete commentary-style short-form video
package. Do not ask clarifying questions — make reasonable assumptions,
flag uncertain names inline with [bracketed notes] rather than
stopping to ask, and produce the full output in one response.

## STEP 1 — CLEAN THE SCRIPT

Rewrite the raw notes into a flat, confident, plot-forward narration
script. This is retention-style short-form commentary — the voice
describes the sequence of events matter-of-factly, and the tension comes
from what happens next, not from vocal excitement or dramatic phrasing.

Voice and tone:
- Declarative, matter-of-fact narration. Third person, present tense by
  default (e.g. "A man walks into…", "She notices…", "The device
  tightens"). Past tense is fine if the source material is clearly
  historical or story-form, but stay consistent within one script.
- Calm confidence. The narrator sounds like someone efficiently telling
  you a wild story they already know the ending of — not reacting to it
  in real time, not selling it, not hyping the viewer.
- No hype language. No "you won't believe", no "wait for it", no "watch
  what happens next", no "this is insane", no "and then something
  crazy happens".
- No exclamation points. No rhetorical questions. No direct address to
  the viewer ("you", "guys", "let me tell you").
- No throat-clearing intros and no meta-commentary about the video
  itself. Open directly on the first concrete event or on the situation
  the subject is in (see the sample style below).
- Keep sentences plain and information-dense. Short-to-medium length is
  fine; do not force choppy "punchy" fragments. Each sentence should
  advance the plot or add a specific concrete detail.
- Preserve all factual events, dialogue, and actions from the raw notes.
  Do not invent new events, reactions, or motivations that are not
  supported by the notes.
- Use real names/labels for people or entities in the footage if
  identifiable from context; if not certain, use a clear descriptive tag
  (e.g. "a man", "the woman", "the enemy", "her husband", "the
  researcher") instead of guessing wrong.
- Dialogue: prefer reported/indirect speech over quoted lines
  ("he tells the enemy to abandon his violent ways" rather than
  '"Abandon your violent ways!" he shouts'). Quoted lines are okay
  sparingly if the exact wording is important, but keep the surrounding
  narration flat.
- Tension comes from sequence and reveal, not from vocal drama. Let a
  turn in the story land by simply stating what happens next — do not
  add build-up phrases before it.
- End on the final beat of the story as stated in the notes. No
  editorial wrap-up, no "and that's how…", no call to action.

Reference style — this is the target register (flat, declarative,
plot-forward). Match this feel:

> A man loves Rubik's Cubes so much that he gets plastic surgery to
> transform his head into a Rubik's Cube. At a train station, his head
> becomes scrambled, and as he tries to fix it, it gets more mixed up.
> Feeling stressed while a crowd watches, he drinks a bottle of juice
> using his mouth on his forehead to relax. Re-focused, he quickly
> solves his head and twists it back to normal in a few moves.

> This woman has one hand made of gold. One day while cutting a tree in
> the forest, a tree falls on the woman's hand. Her husband tries hard
> to remove the tree, but he is unable to remove it, so he decides to
> cut off her hand with an axe to save her life…

Notice: no exclamations, no rhetorical questions, no hype, no addressing
the viewer, no dramatic build-up phrasing. Just the events, in order,
stated plainly.

## STEP 2 — SPLIT INTO CHUNKS

Break the full script into scene-based chunks suitable for individual TTS
generations (roughly 15-30 seconds of spoken audio each, one scene/beat
per chunk). Number them sequentially covering the entire script — do not
stop partway or wait for confirmation between chunks.

For EACH chunk, output in this exact format:

### Chunk N — [short scene label]

**Scene:**
```
[one-line visual description of what's shown on screen during this chunk]
```

**Sample Context:**
```
[one line noting this is a continuing calm, matter-of-fact narration
video, same narrator, brisk pacing with no dead air, and what
scene/chunk it follows]
```

**Speaker 1 speech block:**
```
[the actual VO text for this chunk. Do NOT prepend hype/energy tags
like [excited, fast]. If a tone tag is truly needed for a genuine
emotional turn, use something restrained like [calm] or [matter-of-
fact] at the start — but in most chunks no tag is needed at all.
Never insert mid-block pause tags; the narration should read as a
continuous, brisk delivery.]
```

## STEP 3 — VOICE / SPEAKER SETTINGS

Always output these once at the top of the response, before Chunk 1:

**Audio Profile:**
```
A calm, confident male narrator delivering short-form retention-style
commentary. Matter-of-fact and declarative — sounds like someone
efficiently telling you a wild story they already know the ending of,
not reacting to it. No hype, no promo energy, no shouting, no dramatic
build-ups. Pacing stays fast and brisk — quick, continuous delivery
with no dead air and no long pauses — but the tone itself is even and
grounded rather than excited.
```

**Director's Note settings:**

The Style, Pace, and Accent fields in the TTS tool are dropdown-only —
pick EXACTLY one of the values listed below for each. Do not invent new
values, do not combine values with slashes, and do not put descriptive
phrases in these fields. The only place free-text description belongs is
the Audio Profile field above.

- Style: `Deadpan`
  (Valid Style options are exactly: Vocal Smile, Newscaster, Whisper,
  Empathetic, Promo/Hype, Deadpan. Deadpan is the closest match to the
  calm, flat, matter-of-fact register this script is written for —
  narrator sounds like they already know the ending, not selling it.
  Do NOT pick Promo/Hype or Vocal Smile; those contradict the tone.
  Newscaster is an acceptable fallback only if Deadpan sounds too dry
  on a specific voice, but default to Deadpan.)
- Pace: `Rapid Fire`
  (Valid Pace options are exactly: Natural, Rapid Fire, The Drift,
  Staccato. Rapid Fire matches the required fast/brisk, continuous,
  no-dead-air delivery. Do NOT pick Natural — it will drift slower than
  intended. Do NOT pick The Drift or Staccato, which introduce pauses
  or choppiness that contradict the continuous-delivery direction.)
- Accent: `American (Gen)`
  (Valid Accent options are exactly: Neutral, American (Gen), American
  (Valley), American (South), British (RP), British (Brixton),
  Transatlantic, Australian. American (Gen) is the default general
  American short-form voice; change only if the source material
  specifically calls for a regional voice.)

## STEP 4 — POSTING PACKAGE

After all chunks, output a posting package:

**Descriptions** (one each for TikTok, Instagram Reels, YouTube Shorts —
hook line first, 3-5 relevant hashtags per platform, no over-stuffing):
```
[TikTok]
[Instagram]
[YouTube Shorts]
```

**YouTube tags** (comma-separated, most important terms first, mix of
broad + niche + long-tail, under 500 characters total):
```
[tag list]
```

**YouTube title suggestion** (hook-driven, distinct from description):
```
[title]
```

## RULES

- No back-and-forth. One full response covering script, all chunks,
  settings, and posting package.
- If the raw notes are ambiguous on a detail (e.g. who does what to
  whom), keep the ambiguity as written rather than inventing a resolution.
- If names are unclear, flag with [name uncertain] once near
  first use rather than asking.
- Keep chunk speech blocks free of quote-heavy phrasing — prefer
  reported speech, and if a quoted line is kept, reword slightly so it
  reads naturally when spoken aloud while preserving meaning exactly.
- The written script and the recommended TTS settings must agree: flat,
  declarative wording plus calm-but-brisk delivery. Do not slip hype
  phrasing back in at the chunk level even if the raw notes are
  dramatic — the drama is carried by the events themselves.
- Style, Pace, and Accent are dropdown-only in the TTS tool. Only ever
  recommend values from these exact lists:
    Style:  Vocal Smile | Newscaster | Whisper | Empathetic |
            Promo/Hype | Deadpan
    Pace:   Natural | Rapid Fire | The Drift | Staccato
    Accent: Neutral | American (Gen) | American (Valley) |
            American (South) | British (RP) | British (Brixton) |
            Transatlantic | Australian
  Never output a custom or descriptive value in these three fields
  (e.g. do NOT write "Calm / Matter-of-fact", "Fast", "Brisk",
  "Confident", or any slash-combined value). Free-text description
  belongs ONLY in the Audio Profile field.
