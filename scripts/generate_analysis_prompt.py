#!/usr/bin/env python3
"""
Generate the 00_READ_THIS_FIRST.txt file that Stage A ships alongside the
transcript + screenshots. This file instructs the downstream AI agent how
to select cuts and what cuts.json shape to return.

The duration and frame filename convention are substituted from the actual
Stage A run.

Usage:
    python generate_analysis_prompt.py <duration_seconds> <total_frames>
                                       <output_txt_path>
                                       [--target-duration 120]
                                       [--job-id JOB_ID]
"""
import argparse
import os
import textwrap


TEMPLATE = """\
================================================================================
  READ THIS FIRST — Source-video cut-selection instructions for the AI agent
================================================================================

You have been given three artifacts from a Stage A run of the ClipForge
pipeline:

  1. transcript.json      — timestamped transcript of the video's audio
  2. screenshots.zip      — a zip archive containing one JPEG screenshot
                            per second of the (compressed) source video.
                            Files inside are named frame_00000.jpg ..
                            frame_{last_frame:05d}.jpg (zero-padded 5-digit
                            index of seconds-since-start).
  3. This file            — your instructions

Your job: choose the most engaging moments from this video and output a
`cuts.json` file (schema at the bottom of this document) that ClipForge's
Stage B will use to slice the ORIGINAL full-quality video and stitch a
short-form commentary base.

The narration ClipForge produces from your `raw_narration` field is meant
to explain the video to someone who cannot see it. That means your
`raw_narration` has to describe what is VISUALLY happening on screen —
actions, reactions, expressions, visual gags, scene changes — not just
paraphrase the dialogue. The transcript alone is almost never enough for
this; the screenshots are how you actually see the video.

One specific failure mode to guard against: when you look at many
screenshots to genuinely explain a scene (rather than just spot-checking
dialogue), it becomes very easy to lose track of WHICH CHARACTER IS
WHICH — misattributing an action to the wrong person, swapping two
characters, or conflating them into one. That regresses narration
accuracy even when the scene understanding itself is fine. The
instructions below include a dedicated character-tracking step; treat
it as mandatory, not optional.

--------------------------------------------------------------------------------
VIDEO METADATA (substituted by Stage A)
--------------------------------------------------------------------------------

  Job ID:                  {job_id}
  Full video duration:     {duration_seconds} seconds ({duration_hms})
  Screenshots available:   frame_00000.jpg .. frame_{last_frame:05d}.jpg
                           (one frame per second, zero-padded 5-digit index
                            of seconds-since-start, packaged inside
                            screenshots.zip)
  Target output length:    ~{target_duration} seconds of cuts combined
                           (approximate — favor engagement over hitting the
                           number exactly)

--------------------------------------------------------------------------------
ABOUT THE SCREENSHOTS ARCHIVE — read this carefully
--------------------------------------------------------------------------------

The screenshots ship as a single zip file (`screenshots.zip`) purely for
transport efficiency. Treat it as a normal working input:

  • EXTRACTING screenshots.zip is EXPECTED and REQUIRED. Do it up front,
    the same way you would unzip any other input archive. Extraction is
    a cheap local file operation — it does NOT consume vision tokens and
    does NOT count as "looking at" the images.

  • What is expensive is VIEWING / LOADING / FEEDING-TO-VISION every
    image inside the archive. The thing to avoid is indiscriminately
    piping the entire folder (which can be hundreds or thousands of
    near-identical frames) into your vision context in one shot. Do NOT
    do that.

  • After extraction you will have a `screenshots/` directory full of
    JPEGs sitting on disk, untouched by any vision model. That is the
    correct starting state. From there you will deliberately OPEN the
    frames you actually need in order to understand the video — which
    is more than a token handful, because the goal is genuinely
    describing what happens on screen, not just spot-checking dialogue.

  • Do NOT rely on the transcript alone. In a lot of shorts the visuals
    carry information that the transcript literally cannot: physical
    actions, facial reactions, sight gags, on-screen text, cutaways,
    and scene changes. If you only skim a couple of frames per cut you
    will miss the actual story of the video. View enough frames to
    reconstruct the visual sequence of events for each cut you plan to
    keep.

In short:
    Extract archive        →  ALWAYS do this. Cheap. Expected.
    List/scan the folder   →  fine (it's just filenames on disk).
    Load an image into
      your vision context  →  do this DELIBERATELY, as often as needed
                              to actually understand what is happening
                              visually in the segments you care about.
                              Sample multiple frames per beat/scene, not
                              just one, so you can see how the shot
                              evolves.
    Load every single
      image in bulk        →  DON'T. Indiscriminately viewing every
                              frame of a long video is the one thing to
                              avoid. Be intentional, not exhaustive.

--------------------------------------------------------------------------------
HOW TO SELECT CUTS AND DESCRIBE THEM
--------------------------------------------------------------------------------

STEP 1. Extract screenshots.zip into a local `screenshots/` directory.
        This is a plain unzip — no images are viewed yet, no vision
        tokens are spent. You now have random-access to individual
        frames by filename for the rest of the workflow.

STEP 2. Read transcript.json.
        Look at the `segments` array. Each segment has `start`, `end`,
        and `text`. Use the transcript to get an initial map of what
        the video is roughly about and where the beats are.

STEP 2b. BUILD A CHARACTER ROSTER before you start describing cuts.
        This step exists specifically because viewing many screenshots
        makes it easy to mix up who is who. You will maintain, in your
        own working notes, a small roster of every distinct on-screen
        person who matters, and you will consult it every time you
        write about a character.

        For each distinct person in the video, record:

          - A short stable LABEL you will use for them everywhere in
            `raw_narration`. Prefer a real name if the transcript or
            on-screen text makes it clearly attributable to that
            specific person. If the name is uncertain, or you cannot
            confidently match a spoken name to a specific face, use a
            neutral descriptive tag instead ("the host", "the woman in
            the red jacket", "the older man", "the researcher"). Do
            NOT guess names.
          - A short VISUAL FINGERPRINT: a couple of the most
            distinguishing stable traits you can actually see in the
            frames — e.g. hair color/length, facial hair, glasses,
            clothing color, approximate age, setting they appear in,
            role in the scene. Pick traits that stay consistent across
            the video, not traits that change shot-to-shot (like head
            angle).
          - The rough time range(s) where they appear (from the
            transcript beats and/or the frames you have already
            sampled).
          - Who they interact with, and any explicit relationship the
            transcript states ("her husband", "the interviewer",
            "the suspect").

        Rules for the roster:

          - One label per person. Do NOT switch between multiple labels
            for the same person across cuts (e.g. do not call the same
            man "the researcher" in one cut and "the scientist" in
            another).
          - Different people MUST get different labels, even if they
            look superficially similar (same uniform, same hair color,
            same setting). If two people are genuinely hard to tell
            apart from the frames, that is important information —
            note it, and describe them by the trait that actually
            distinguishes them (position in frame, who they are
            talking to, what they are holding) rather than picking one
            at random.
          - If a new person shows up mid-video who is not yet in the
            roster, add them before writing narration for that cut.
          - When the transcript uses a pronoun ("he", "she", "they")
            or a role word ("the guy", "the woman") whose referent is
            not obvious from the text alone, RESOLVE it against the
            screenshot(s) for that timestamp before writing narration.
            Do not carry an unresolved pronoun into `raw_narration`.

        You do not need to output this roster in cuts.json — it is a
        working aid — but you must actually build it and use it. The
        labels you commit to here are the labels that must appear in
        every `raw_narration` field.

STEP 3. Identify candidate ranges from the transcript AND from a first
        pass over the visuals.
        Prioritize:
          - Emotional peaks (shouting, whispered reveals, laughter,
            silence between heavy lines, visible strong reactions)
          - Key beats (someone learning something, a reveal, a
            confrontation, a decision, a turning point — spoken OR
            purely visual)
          - Defining lines (memorable quotes, callbacks, strong claims)
          - Action beats and visual gags — physical action, a stunt, a
            prop reveal, a facial reaction, on-screen text — that the
            transcript may not mention at all
          - Cliffhanger-style openings or endings
        Skip:
          - Long silent expositional stretches with no visual payoff
          - Recap/preview sections
          - Intro/outro songs or credit sequences if the transcript
            or a quick frame check makes them obvious

        To catch visual-only beats that the transcript is silent on,
        it's fine to sample frames at a coarse interval across the
        whole video (for example every ~20-30 seconds) as a first pass,
        then zoom in on the segments that actually look interesting.
        That coarse pass is deliberate sampling, not bulk-viewing every
        frame.

STEP 4. For each candidate range you plan to keep, VIEW enough
        screenshots to actually understand what is visually happening
        across that range — not just one frame to "confirm" the
        transcript. Filename convention:

            frame_<seconds-since-start>.jpg    (zero-padded to 5 digits)

        e.g. for a moment around 4 minutes 32 seconds in, that is
        second 272, so view `screenshots/frame_00272.jpg`. For a
        candidate cut from 142s to 168s, view a spread of frames
        across that range (e.g. the start, several points in the
        middle where the action changes, and the end) so you can
        actually see how the scene evolves — a reaction shot, a prop
        entering frame, a cut to a new location, etc.

        Guidance on how many frames to view:
          - Aim for enough coverage that you could confidently write a
            plain-prose description of what a viewer sees during the
            cut, including any visual beat that isn't spoken.
          - Sample MORE frames when the shot is action-heavy, changes
            location, or clearly has visual gags / reactions that the
            transcript won't capture.
          - Sample FEWER frames when the shot is a static talking head
            and the transcript already describes the content well.
          - The rule is "look at enough to describe it honestly", not
            "look at as few as possible". The only hard limit is: do
            not indiscriminately dump every frame of the video into
            vision — be intentional about which frames and why.

        As you view frames for a cut, actively CROSS-REFERENCE against
        the character roster from Step 2b:

          - For every person visible in a frame you are about to
            describe, identify them by matching their visual
            fingerprint (hair, clothing, facial hair, glasses, role in
            scene) to a specific roster entry BEFORE you write about
            them. If the person in the frame is genuinely a new
            character, add them to the roster first; do not silently
            reuse an existing label for them.
          - Cross-check the transcript timestamps against what is on
            screen at that second. If the transcript says a specific
            named person is speaking at 148s but the frame at 148s
            shows a different person from your roster (e.g. a cutaway,
            a reaction shot, or the actual speaker is off-camera),
            the SPEAKER and the ON-SCREEN PERSON are two different
            things — do not merge them into one label. Attribute the
            spoken line to the speaker and describe the on-screen
            person separately.
          - When multiple people are on screen at once, decide who is
            doing what by their position, gaze, and action in the
            frame — not by which name was most recently mentioned in
            the transcript. Recency in the transcript is a common
            source of misattribution; the frame is the ground truth
            for who is physically doing an action.
          - If a shot is ambiguous about identity (e.g. back of head,
            heavy shadow, distance, motion blur) and you cannot
            confidently tell which roster entry it is, DO NOT force a
            label. Describe the action with a neutral referent ("one
            of the two men", "someone off-screen") rather than
            guessing. Wrong-name is worse than vague.

STEP 5. Assemble cuts.

        - Order them chronologically by `start_seconds`.
        - Each cut should be self-contained enough that a viewer landing
          on it makes sense — favor cutting at natural sentence / beat
          boundaries from the transcript, not mid-word.
        - Target the sum of (end - start) across all cuts at roughly
          {target_duration} seconds. It does NOT need to be exact — prefer
          slightly longer or shorter if the engagement is better.
        - For each cut, write a `raw_narration` field: a plain,
          matter-of-fact description of WHAT HAPPENS in that segment,
          the way a viewer who can see the screen would describe it to
          someone who cannot. Cover the visual sequence of events
          (actions, reactions, expressions, scene changes, on-screen
          text, visual gags) as well as any essential dialogue, in
          chronological order. Not a script, not stylized, not
          dramatized — just the raw beats, in order. This is what
          ClipForge feeds into the master conversion prompt to produce
          the final commentary.
        - Use the character roster from Step 2b as the SINGLE SOURCE
          OF TRUTH for who is who. Every reference to a person in
          `raw_narration` must resolve to exactly one roster entry,
          and the same person must be referred to with the same label
          every time they appear — including across different cuts.
          Do not introduce a new descriptive tag mid-way through
          ("the man in the jacket" in one cut, "the guy" in the next)
          for the same person; pick the roster label and stick to it.
        - Before finalizing each cut, do a quick self-check: for every
          action, line, or reaction you attributed to a specific
          person, would the actual frames at those timestamps confirm
          that same person did/said it? If not, fix the attribution
          (or fall back to a neutral referent) before moving on.

--------------------------------------------------------------------------------
OUTPUT SCHEMA — cuts.json  (return EXACTLY this shape, no extra keys)
--------------------------------------------------------------------------------

{{
  "video_duration_seconds": {duration_seconds},
  "cuts": [
    {{
      "start_seconds": 142,
      "end_seconds": 168,
      "raw_narration": "plain, matter-of-fact description of the visual sequence of events in this segment (actions, reactions, scene changes, essential dialogue), in chronological order, the way a viewer would describe it to someone who cannot see the screen"
    }}
    // ... more cuts, ordered chronologically ...
  ],
  "target_total_duration_seconds": {target_duration}
}}

CONSTRAINTS
  - `start_seconds` and `end_seconds` are integers, in seconds since the
    start of the video. `end_seconds > start_seconds`. Both must lie
    within [0, {duration_seconds}].
  - Cuts MUST NOT overlap.
  - Cuts MUST be sorted ascending by `start_seconds`.
  - `raw_narration` is plain prose. No markdown, no timestamps inside it,
    no name guessing when unsure — use clear descriptive tags like
    "the researcher" or "the host" if unclear. Describe what is
    visually happening, not just what is said.
  - Character identity must be consistent across ALL cuts. The same
    person gets the same label every time; two different people never
    share a label. If you are not sure which roster entry a person in
    a frame is, use a neutral referent instead of guessing a name.
  - Return ONLY the JSON, no surrounding prose, no code fences. It will
    be uploaded verbatim to ClipForge Stage B.

================================================================================
"""


def hms(sec: int) -> str:
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    if h:
        return f"{h:d}h{m:02d}m{s:02d}s"
    return f"{m:d}m{s:02d}s"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("duration_seconds", type=int)
    ap.add_argument("total_frames", type=int)
    ap.add_argument("output_txt")
    ap.add_argument("--target-duration", type=int, default=120)
    ap.add_argument("--job-id", default="(unknown)")
    args = ap.parse_args()

    last_frame = max(args.total_frames - 1, 0)
    content = TEMPLATE.format(
        job_id=args.job_id,
        duration_seconds=args.duration_seconds,
        duration_hms=hms(args.duration_seconds),
        last_frame=last_frame,
        target_duration=args.target_duration,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output_txt)) or ".", exist_ok=True)
    with open(args.output_txt, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Wrote analysis prompt to {args.output_txt} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
