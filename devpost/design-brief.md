---
status: draft
---

# Design brief: SoundCraft Orbit (mini-DAW Lens)

<!-- Filled in by plan-lens from the learner's interview. Use the learner's words. Mark any value they didn't choose as (default). -->

<!-- DRAFT provenance, added by the drafting agent (not part of the official template): this brief was written from the learner's interview answers given in a prior session, preserving their words and choices. The official interactive plan-lens interview was NOT run in this session. This session also did not start inside the project folder (the .esproj lives in the lens-studio-specs/ subfolder, and the lens-studio MCP connection and CLAD plugin were not verified from that folder here), so full official plan-lens skill compliance is NOT claimed. Status stays draft until the learner reads it and approves it. -->

## The one spatial moment
You stand in your room inside a fun mini DAW in glasses, like FL Studio Mobile but around you instead of on a screen: two or three room-fixed, movable, floating, playable, gesture-based instruments within arm's reach. You turn your head to select the focused instrument and its effects, play it with your hands, reactive pulsating visuals answer back, and everything you play is captured automatically into a growing take in a simple playlist with its timing. SoundCraft is the actual backend and owner of the editable song, reached through an authenticated, restricted companion API. The Lens supplies immediate, explicitly local sound monitoring and an original vaporwave demo; this must not be confused with backend audio streaming. Only a confirmed backend save may be labelled saved. Offline playing remains visibly local and unsynced.

## Why it belongs on glasses
- Uses: draws in the world (instruments anchored in the room around you at real scale) + leaves your body free (hands play in the air, eyes up, no desk)
- Why it's better than the phone or laptop version: FL Studio Mobile squeezes everything behind a touchscreen; here the instruments float around you at arm's reach, a head turn selects, and playing is physical instead of tapping a flat panel.

## Product or overlay
- Type: product — the virtual thing is the experience; instrument-focused, not a recording suite
- What the real version would sense: nothing in the real world needs recognizing — the inputs are your head turn and your hands
- Stand-in for the preview: custom gestures and hand speed can't be tried or shown in the preview, so standard SIK pinch/drag on big targets carries the playing; voice is paired with a small visual control the user chose; no recognition stand-in is needed. Real backend saving is required, not a simulated take animation (see Risks).

## Where things live
- Where the user is looking during the main task: straight ahead and around them, sweeping across the instrument arc; the playlist sits at the edge of that view
- Instruments (two or three): floating panels anchored to the room (world-fixed, so they stay put when you move), movable by grab and drag, each ~60–100 cm away — within arm's reach (default, inside the 0.6–1.6 m comfort zone) — a little below eye level, each ~35–45 cm wide (default, inside the usable area at that distance). Instrument types were not decided by the learner — (default) a pad grid and a small keyboard, vaporwave-flavored; a third instrument only if the flow stays clean
- Playlist panel: small floating list anchored to the room ~1 m away at the side of the instrument arc, a little below eye level (default), showing take entries with their timing (start and length); it grows automatically as you play
- Pan-link toggle and voice-fallback buttons: small buttons on or beside each instrument, and next to the playlist

## Hands and input
- Select an instrument: turn the head toward it — in the preview, mouse-look — and it highlights as selected; a pinch confirms the selection (default guard so gaze alone can't misfire)
- Play: pinch / drag on the selected instrument's pads or keys (SIK standard interactions stand in for the gesture-based playing)
- Move an instrument: grab and drag it to a new spot; its stereo pan follows its placement while the pan link is on
- Disable the pan link: a button on the instrument, so placement stops controlling panning — the user may switch the link off
- Targets are big and highlight when aimed at.
- Voice (if any) and the button that does the same job: voice commands like "play" and "stop" would be nice; every voice action has a small visible button next to the playlist that does the same job, and in the preview those buttons carry the action.

## When things show
- Instruments: in the room the whole time you play; their visuals pulse and react while played and calm down when idle
- Playlist: appears and grows automatically as takes are captured; recedes (dims) while you are playing and comes back when a take completes or you look over
- If something needs attention out of view: a short sound cue and a small arrow toward the playlist when a take is captured (default)

## Done criteria
Each one can be checked in Lens Studio's preview.
1. Two floating instruments sit anchored in the room at arm's reach, and grabbing and dragging one moves it, leaving it where you let go.
2. With the pan link on, dragging an instrument left or right of your center changes its stereo pan to match where it sits; pressing the link toggle stops placement from changing pan.
3. Turning toward an instrument (mouse-look in the preview) highlights it as selected, and pinching its pads or keys plays vaporwave demo-track sounds that come from where that instrument sits, while its visuals pulse as you play.
4. Playing grows a take with its timing in the simple playlist automatically, without pressing record. After the phrase, the paired companion commits its notes into the real SoundCraft document and confirms a versioned project save. Reopening that saved project retains editable notes. The Lens shows pending, saved, failed, unknown, and offline/unsynced distinctly; replaying a network request must not duplicate a take. Playback of a saved take is a separate check and must not be claimed merely because local pad sounds play.
5. The small visual fallback button next to the playlist does the same job as each voice command ("play", "stop"), and it works in the preview where voice may not.

## Out of scope
- Playlist and mixer editing (rename, reorder, trim, mix levels) — play first, editing later
- Recording-suite features (multi-track recording, stem export)
- Full live DAW streaming, third-party plugin interfaces, and automatic AI arrangement are not part of this first playable slice. They must not be represented by fake controls or canned replies.
- Custom two-hand gestures, hand speed, or hand-pose input as built controls (stand-ins carry the demo)
- Two people sharing one Lens

## Risks and open questions
- Backend status as of 5 November: SoundCraft main `c8e1bfb` includes editable take commits and protected versioned automatic saves in the companion, with subprocess save/reopen tests. This is not yet a deployed or Lens-connected result. The Lens prototype currently uses local audio and a labelled simulated/session-only take bar; it does not meet criterion 4 yet. Headless transport remains a labelled simulation and no backend live note monitoring is implemented. Backend tests must not be presented as evidence of playable glasses or successful Lens networking.
- The private HTTPS/Tailscale connection is intended for Lens Studio Preview on the paired laptop. Hardware glasses and public judges do not automatically have tailnet access; judge access must be solved or the limitation clearly disclosed without publishing cluster credentials.
- The user kept gesture-based instruments despite the preview limit; standard pinch/drag carries the demo, and the on-glasses gesture feel stays "feel unproven".
- Head-turn selection can misfire; the confirm pinch guards it (default), and comfort over time is "feel unproven".
- Voice may not work in the preview; the user already chose the small visual control fallback.
- Which effects the head turn reaches, and how a turn maps to them, is still open; (default) one simple effect (echo) with its amount on the selected instrument until decided.
- "Two or three" instruments: build two first, add the third only if the flow stays clean.

## Build notes for CLAD
- Build for SPECS so it runs and can be demonstrated in Lens Studio's preview. No SPECS device is available.
- Use Spectacles Interaction Kit (SIK) and UI Kit for all interactions, so they work with the mouse in Interactive Preview and with LEAF.
- Build any stand-in exactly as described above, and keep it obvious in the scene.
- Use real-world scale in centimeters. Keep content inside the user's view during the main task.
- The display is additive: black renders as transparent. Don't rely on black or very dark content to be seen; keep text light and readable from where the user stands.
- Get the basic flow working first, then add detail.
- Write LEAF scenarios for each done criterion, run them in preview, and report which pass. Say which criteria have no test.
- Don't record, identify, or follow people.

## After the build: judge it
This part is for you, after CLAD finishes.

1. **Does it work?** Ask your agent which LEAF tests passed and which done criteria have no test.
2. **Walk around it.** Open the preview in Interactive Preview. Use WASD to move, Q and E to go down and up, and right-drag (or hold Shift) to look around. Clicking acts as a pinch. Stand where a user would and look at the task.
3. **Ask the three questions.**
   - Does it use what I'm looking at?
   - Does it put something in my space, where it belongs?
   - Does it free my hands or let me keep my eyes up?
   - Would it be just as good on a phone? If so, what would make it need the glasses?
4. **Check comfort.**
   - Everything I need is in view while I do the task. Nothing sits at the edges, behind me, or stuck to my face.
   - Every control is within reach of someone standing there.
   - Text reads easily from where I stand. No dark UI disappearing.
   - Things show when needed and get out of the way.
5. **Label what you know.** Write "logic proven" next to anything the tests and preview show working, and "feel unproven" next to anything only real glasses could tell you (comfort over time, real hand tracking, real recognition).
6. **Fix with design notes, not code.** Tell your agent what to change in design terms, for example: "Move the step card 15 cm lower and next to the pan. Make the Next button twice as big. Re-run the tests." If a fix takes under a minute, like nudging a panel, do it yourself in the scene.
7. **Submit.** Record a video under 3 minutes of your Lens in the preview, public on YouTube. Make your repo public with your Lens Studio project and this `devpost/` folder. Details are on the hackathon site: https://learn-specs.devpost.com/resources
