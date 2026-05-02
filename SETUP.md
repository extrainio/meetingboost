# MeetingBoost — Setup & Troubleshooting

This doc covers ship-blocking setup issues users hit:

1. **Audience can't hear sounds** in Teams/Zoom/Meet (BlackHole routing).
2. **DMG / first-run nightmares** (“disk corrupted”, German *„beschädigt“*, Gatekeeper) when the app wasn’t Developer ID-signed and notarized.

---

## 1. Make the audience hear your sounds (BlackHole routing)

BlackHole 2ch is a virtual audio cable. MeetingBoost plays *into* it, and your
meeting app reads *from* it as if it were a microphone. There are three
moving parts; missing any one means silence on the other end.

### One-time install

```bash
brew install --cask blackhole-2ch
```

Then **restart your Mac**. BlackHole is a kernel extension; it doesn't load until reboot.

Verify it's there:
```bash
system_profiler SPAudioDataType | grep -i blackhole
# → should print "BlackHole 2ch:"
```

### Hear-yourself setup (recommended): Multi-Output Device

If you only route to BlackHole, *you* won't hear the sounds — only the
audience will. The fix is a Multi-Output Device in macOS.

1. Open **Audio MIDI Setup** (`/Applications/Utilities/Audio MIDI Setup.app`).
2. Click `+` (bottom-left) → **Create Multi-Output Device**.
3. Tick both **BlackHole 2ch** and your speakers/headphones.
4. Set the speakers as the *Master Device* (top of the list).
5. Tick **Drift Correction** for BlackHole only.
6. Right-click the new device → rename to `MeetingBoost Output`.

### App configuration (every meeting)

| Where             | Setting                | Value                              |
| ----------------- | ---------------------- | ---------------------------------- |
| MeetingBoost      | Settings → Audio → Output | `MeetingBoost Output` (or `BlackHole 2ch` if you don't need to hear them yourself) |
| Teams / Zoom / Meet | Microphone             | **`BlackHole 2ch`**                |
| Teams / Zoom / Meet | Noise suppression      | **OFF** (or "Low") — see warning below |

> ⚠️ **Teams' default noise suppression kills sound effects.** It's voice-only by
> design. Settings → Devices → Noise suppression → set to **Low** or **Off**.
> Zoom: Settings → Audio → Suppress background noise → **Low** + uncheck "Echo cancellation"
> for tests.

### How to verify it works (local test)

There's a script in `scripts/test-blackhole.sh` that records audio coming out of
BlackHole and tells you, with a peak-level number, whether ANY signal arrived.

```bash
# from the project root
./scripts/test-blackhole.sh           # 8s default
./scripts/test-blackhole.sh 5         # 5s
./scripts/test-blackhole.sh 8 ~/test.wav   # custom output path
```

What it does:
1. Auto-detects BlackHole's AVFoundation index (varies per machine).
2. Counts down 3s, then records 8s into a WAV file.
3. While it records → spam Q/W/E/R/T in MeetingBoost.
4. Prints `mean_volume` / `max_volume` (in dB) so you know if signal landed.
5. Plays the captured WAV back through your speakers.

Pass criterion: `max_volume > -60 dB` AND you hear the sounds in playback.
Anything around `-91 dB` means the buffer is digital silence — routing isn't
working. Common causes when this happens:

- MeetingBoost's output device is still on `System default` (check Settings → Audio).
- The pads you pressed were empty (dashed border) — use Q/W/E/R/T, those have
  sounds in the Classics pack.
- You ran the script before pressing keys — start the script first, *then* spam.

### How to verify the audience hears it (in a real meeting)

Two options:

- **Easiest**: join a Teams meeting from a second device (phone). Mute the
  phone's mic & speaker. Press a sound key on the laptop. The phone should
  show audio activity on your username and play the sound.
- **Self-loop**: Teams → Settings → Devices → "Make a test call". The bot
  records 5 seconds and plays back. Press sounds during recording. If the
  playback contains your sound effects, the audience would hear them.

### Known code-level fix

The audio routing race condition (sounds playing on the wrong device on the
first ~100ms of a clip) was fixed in `src/board.html` — `setSinkId()` is now
awaited *before* `audio.play()`. Failures log to the devtools console
(open with `Cmd+Option+I` while the board window is focused).

---

## 2. "The disk image is corrupted" — or German: *„MeetingBoost ist beschädigt und kann nicht geöffnet werden“*

The bytes are usually not corrupted. macOS commonly uses **“damaged” / German *beschädigt*** when **Gatekeeper rejects the bundle** (failed signature verification, Developer ID absent, missing notarization, or downloaded **quarantine**). Same underlying issue as English *“cannot be opened because Apple cannot verify it”*, not truncated transfers.

Teams / SharePoint can still provoke false **“disk image corrupted”** messages — see **Option B** below.

Verify it's not real corruption:
```bash
shasum -a 256 release/MeetingBoost-1.0.0-beta-arm64.dmg
# Have the recipient run the same command on their downloaded copy.
# If hashes match → it's Gatekeeper, not Teams.
```

Check the current signing state:
```bash
codesign -dv --verbose=4 release/mac-arm64/MeetingBoost.app 2>&1 | grep -E "Signature|TeamIdentifier"
# Unsigned CI builds: Signature=adhoc, TeamIdentifier=not set → Gatekeeper will flag.
```

**Strict verification + rehearsal** (run after `npm run dist`, or point at `.app` from a mounted DMG):

```bash
npm run verify:mac-bundle                                    # defaults to release/mac-arm64/MeetingBoost.app
scripts/verify-macos-bundle.sh '/Volumes/MeetingBoost/MeetingBoost.app'   # DMG-mounted copy
```

By default this checks **bundle layout only** — enough for CI and local builds **without an Apple Developer account**. Electron **ad hoc** bundles often fail `codesign --verify` (linker-signed components); strict signing checks are meaningless until you use **Developer ID**.

For a **Developer ID** build locally, enable strict verification:

```bash
STRICT_CODESIGN_VERIFY=1 ./scripts/verify-macos-bundle.sh
```

Combine with Gatekeeper rehearsal (needs notarisation to pass reliably):

```bash
STRICT_CODESIGN_VERIFY=1 REQUIRE_GATEKEEPER_PASS=1 ./scripts/verify-macos-bundle.sh
```

CI passes **`STRICT_CODESIGN_VERIFY=1`** when signing secrets (**`CSC_*`**) exist, and **`REQUIRE_GATEKEEPER_PASS=1`** when those plus all Apple notary secrets are configured.

Extras by hand:

```bash
spctl -a -vv /path/to/MeetingBoost.app
xattr -l /path/to/MeetingBoost.app   # look for com.apple.quarantine → xattr workaround below
```

### Workaround until you have a Developer ID cert

**Option A — Ship the .zip, not the .dmg.**
`package.json#build.mac.target` already builds both. The ZIP is less prone to
the "corrupted" misdiagnosis because macOS doesn't try to *mount* it.

```bash
npm run dist            # builds both .dmg and .zip
ls release/             # → MeetingBoost-1.0.0-beta-arm64-mac.zip is the one to send
```

Send the `.zip`. Tell the recipient to unzip and drag `MeetingBoost.app` to
`/Applications`, then run **once**:

```bash
xattr -cr /Applications/MeetingBoost.app
```

That clears the quarantine flag, after which Gatekeeper allows the app to
launch (Right-click → Open the first time still required on stricter macOS
configs).

**Option B — If you must ship a DMG over Teams**, wrap it in a ZIP first:

```bash
cd release/
zip MeetingBoost.dmg.zip MeetingBoost-1.0.0-beta-arm64.dmg
```

The wrapper ZIP prevents Teams/SharePoint AV from peeking inside the DMG.
Recipient unzips, then:

```bash
xattr -cr ~/Downloads/MeetingBoost-1.0.0-beta-arm64.dmg
open ~/Downloads/MeetingBoost-1.0.0-beta-arm64.dmg
```

The `xattr -cr` removes `com.apple.quarantine` so Gatekeeper stops
mis-reporting it.

### Real fix (do this before public ship)

**Without a paid Apple Developer Program membership** ($99/yr) you cannot issue **Developer ID** signatures or **notarise**. Public downloaders will keep seeing Gatekeeper warnings; use § 2 **workarounds** (ZIP + `xattr -cr` + Right-click → Open) for testers you trust until you enrol.

See `SHIPPING.md` § "Code-signing & notarization":

1. Buy an Apple Developer ID ($99/yr).
2. Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` to GitHub
   Action secrets.
3. `mac.notarize: true` is set in `package.json#build` — notarization runs when Apple secrets are present; without them electron-builder skips it.
4. Re-build. The DMG will then ship cleanly through Teams without any
   incantations on the recipient's side.

---

## Quick triage cheatsheet

| Symptom                                | First check                                                  |
| -------------------------------------- | ------------------------------------------------------------ |
| Audience hears nothing                 | Teams mic input set to BlackHole 2ch?                        |
| Audience hears nothing, mic is right   | Teams noise suppression OFF?                                 |
| Audience hears nothing, suppression off | Run `./scripts/test-blackhole.sh` — does it report signal?  |
| You hear nothing yourself              | Configure Multi-Output Device per § 1                        |
| "Disk image corrupted" / DE *„beschädigt“* | Gatekeeper; see § 2 · `npm run verify:mac-bundle` · ship .zip + `xattr -cr` if unsigned |
| First-run "MeetingBoost can't be opened" | Right-click app → Open (only required first time on unsigned builds) |
