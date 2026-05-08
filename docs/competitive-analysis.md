# Competitive Analysis: MeetingBoost

*Quick-map for positioning and landing-page direction. Current as of May 2026.*

---

## 1. Quick Map

**Voicemod** (voicemod.net)
Real-time voice changer with a soundboard bolted on. Primary audience: streamers, gamers, Discord communities. Pricing: free tier (limited voices), Pro at ~$4.50/mo on annual billing. Windows-native; Mac version was in public beta as of late 2025 with no shipping date commitment. Technically capable — 100+ voices, AI voice synthesis, soundboard hotkeys — but the product identity is pure streamer-consumer: loud UI, heavy branding, deep game-platform integrations. The meeting-host use case is an afterthought, and Mac parity is unresolved.

**Soundpad** (leppsoft.com / Steam)
One-time purchase soundboard for Windows, $4.99 on Steam. Plays audio through a virtual microphone into any voice chat — Discord, Teamspeak, in-game. Solid execution on its narrow promise: hotkey-per-clip, built-in recorder, volume normalization, C++ performance. No Mac support, no pack/import system, no meeting-context tooling. The UX is utilitarian but entirely mouse-driven — you manage a flat file list. A workman's tool that has never claimed to be anything else.

**Clownfish Voice Changer** (clownfish-translator.com)
Free voice changer with a soundboard tab. Available on Windows, Mac, Android, and iOS. Works as a system-level audio filter so it applies to any app: Discord, Zoom, Skype, Fortnite. Technically cross-platform, but the product is aggressively consumer-entertainment — voice effects named "Alien," "Robot," "Baby" — and the UI reflects that. No pack system, no keyboard-first design, no meeting-specific feature surface. The Mac version exists but is a secondary target. Free is the entire value proposition.

**Discord Soundboard** (discord.com)
Built-in soundboard launched in Discord voice channels in April 2023. Free for server members; cross-server use and custom entrance sounds require Nitro ($9.99/mo or $99.99/yr). Clips are capped at 5 seconds and must be uploaded via desktop. Six default sounds ship globally; servers can add custom sounds. Strong network effect — zero install friction for Discord users — but hard constraints: 5-second cap, only works inside Discord voice channels, no hotkey-from-keyboard system, no offline use, no routing to Zoom or Meet. Eats the casual-Discord end of the market; irrelevant to meeting hosts running Zoom.

**Elgato Stream Deck** (elgato.com)
Hardware panel (15 LCD keys on the standard model, $149.99; additional SKUs up to ~$400) with companion software. The software ships a native Soundboard action and integrates with Soundpad via a plugin. Keyboard-adjacency is real — you can hit a physical button to trigger audio. But the experience is hardware-gated: no Stream Deck, no benefit. Software-only use is possible but treated as a second-class path. The aesthetic is broadcast-console, which is the closest visual reference to MeetingBoost. Audience is streamers and production setups, not laptop-only meeting hosts. Price of entry and hardware dependency are the blockers.

**Resanance** (resanance.com)
Free Windows soundboard used by 500k+ users, popular on Discord and Twitch. Unlimited sounds and hotkeys, MIDI support, per-clip volume control, TTS. Not open source — free as in gratis. Windows only; no Mac, no pack format, no meeting-context framing. Resanance fills the "free Soundpad alternative" slot for Windows gamers. The UX is mouse-driven list management. No meaningful differentiation from Soundpad on the dimensions that matter for MeetingBoost.

**Audio Hijack / Loopback — Rogue Amoeba** (rogueamoeba.com)
Not a soundboard — an audio routing and recording suite for macOS. Loopback ($99 single-user) creates virtual audio cables between applications; Audio Hijack records any audio source. Together they are the plumbing layer that power users assemble before picking a soundboard. Mac-native, actively maintained, used by podcasters and audio engineers. MeetingBoost depends on BlackHole rather than Loopback, but the category overlap is conceptual: Rogue Amoeba tools require manual pipeline construction; MeetingBoost wraps routing into the product. Relevant as context for the Mac audio-routing space, not as a direct competitor.

---

## 2. Positioning Grid

Two axes that split the field cleanly:

- **X: Consumer/streamer-flashy ← → Operator/professional-quiet**
- **Y: Mouse/click-driven ← → Keyboard/shortcut-driven**

```
                    KEYBOARD / SHORTCUT-DRIVEN
                              │
                              │
            MeetingBoost ●    │
                              │
                              │    Stream Deck ●
                              │    (hardware keys, not keyboard)
   OPERATOR ─────────────────────────────────────── CONSUMER
   PROFESSIONAL               │                     STREAMER
                              │
           Soundpad ●         │         Voicemod ●
                              │
          Resanance ●         │    Discord Soundboard ●
                              │
                    Clownfish ●
                              │
                    MOUSE / CLICK-DRIVEN
```

| Competitor | Quadrant | Justification |
|---|---|---|
| Voicemod | Consumer / Mouse | Feature surface built for stream overlays and Discord bots; click-through UI |
| Soundpad | Consumer–middle / Mouse | Utilitarian but Windows-gaming audience; flat list managed by mouse |
| Clownfish | Consumer / Mouse | Entertainment voice effects, no hotkey-first UX |
| Discord Soundboard | Consumer / Mouse | Click the emoji button in voice channel; 5-second party sounds |
| Stream Deck | Consumer–Operator / Keyboard-adjacent | Closest to operator aesthetic; hardware keys, not keyboard shortcuts |
| Resanance | Consumer / Mouse | Gaming community, click-driven list |
| Rogue Amoeba | Operator / Mouse | Professional audio; pipeline built by dragging blocks, not typing shortcuts |
| **MeetingBoost** | **Operator / Keyboard** | **Home-row everything; broadcast-console aesthetic; meeting-host audience** |

**Most populated quadrant**: Consumer / Mouse — five of seven competitors cluster here.

**Empty quadrant**: Operator / Keyboard — MeetingBoost is alone.

---

## 3. White Space

**Mac-native soundboard, keyboard-driven, free, meeting-host focused.**
Every keyboard-adjacent competitor (Stream Deck) requires hardware. Every Mac-compatible competitor (Clownfish, Voicemod beta) is consumer-voice-changer, not meeting infrastructure. Soundpad and Resanance are Windows-only. MeetingBoost owns this quadrant today without needing to build anything new. The claim is defensible because BlackHole integration and keyboard routing are already shipped.

**Pack portability (.mbpack) with no equivalent in the field.**
No competitor offers a team-shareable, import/export sound pack format. Discord Soundboard locks sounds to a server. Soundpad has no pack concept. This is a workflow gap for recurring meeting facilitators and developer-advocate teams who want consistent brand sounds across sessions. MeetingBoost can claim it today; the YouTube Pack import extends this into async curation. What it would need to build to deepen the moat: pack versioning, a public pack registry, or a CLI tool for CI-driven pack deployment.

**No voice-changer baggage.**
"Soundboard" in search results is contaminated by voice changers, gamer tools, and party-sound apps. MeetingBoost's audience (meeting hosts, developer advocates, remote facilitators) does not self-identify as soundboard users. The white space is "meeting audio toolkit" positioned as operator infrastructure — a framing none of the competitors occupy. No build required; this is a positioning claim available now.

**YouTube-sourced content pipeline for meeting audio.**
The YouTube Clip and YouTube Pack import features have no analog in any surveyed competitor. Facilitators who pull audio from chaptered YouTube content — conference talks, product demos, recurring meme clips — have no tool for this. This is a compounding advantage: the larger the YouTube library, the more useful MeetingBoost becomes relative to competitors that require manual file management.

---

## 4. Implications for the Landing Page

- **Differentiate against Voicemod by category, not by features.** The copy should make clear this is not a voice changer and not for gamers — one sentence that disqualifies the wrong audience is more valuable than a feature list that could describe either product.

- **Lead with the keyboard mechanic.** It is the single most differentiating claim in the entire competitive map. Show keystrokes, not screenshots of a soundboard grid.

- **Lead second with the meeting-host audience signal.** Name the roles (developer advocates, community managers, remote facilitators) rather than describing a use case abstractly. Every competitor except Discord names "gamers" or "streamers" first.

- **Lead third with Mac + free.** "Mac-native, MIT-licensed, open source" is a rare combination in this space — state it factually, don't dwell on it.

- **Deemphasize "voice effects."** The word is Voicemod and Clownfish territory. MeetingBoost plays sounds, it does not modify voice. Avoid "voice" as a primary descriptor.

- **Deemphasize "soundboard."** Useful for SEO, harmful for positioning. Use it once in metadata; don't lead with it. The word pattern-matches to gamer/streamer tools in every user's head.

- **The .mbpack format is a quiet differentiator to surface.** It signals "professional workflow" without requiring explanation. One line — "share packs with your team" — is enough.

- **Do not compare to Stream Deck.** It reads as justifying hardware spend. MeetingBoost is the no-hardware path; let that be implicit.
