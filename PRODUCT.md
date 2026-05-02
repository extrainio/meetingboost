# Product

## Register

product

## Users

Meeting hosts, developer advocates, community managers, and remote team facilitators who run video calls on macOS. They have the soundboard open as a secondary window while their primary screen is Zoom, Teams, or Meet. They trigger sounds without looking away from the meeting — speed and accuracy matter more than discoverability. Power users reach for keyboard shortcuts first; mouse is the fallback.

## Product Purpose

MeetingBoost is a keyboard-driven soundboard for macOS that routes audio through virtual drivers (BlackHole 2ch) directly into meeting audio — no manual switching, no alt-tabbing into audio settings. It exists because injecting a rimshot or airhorn mid-call should take one keypress, not six clicks. Success: a user fires the right sound at the right moment, the meeting laughs, and no one knows how they did it.

## Brand Personality

Operator. Direct. Precise.

The app should feel like broadcast console software — the kind professionals use without reading the manual. Confident, minimal, built for people who know what every key does. Not playful-startup energy, not pro-audio maximalism. The humor lives in the sounds, not the interface.

## Anti-references

- SaaS purple gradient apps (Notion, Linear clones, anything with `linear-gradient(135deg, #a78bfa, #f472b6)`)
- Consumer-brand soundboard apps (Voicemod, Clownfish — too flashy, too many CTAs)
- Podcast/streaming tools (Riverside, Descript — wrong register, content-creator not operator)
- Streamdeck default UI — too icon-grid, too orange-on-black consumer

## Design Principles

1. **Keyboard native, mouse tolerant.** Every action reachable from the home row. The grid layout maps to physical key positions. Mouse is never required.
2. **Feedback is immediate and unambiguous.** When a key fires, the tile reacts before any sound plays. The user never wonders if it registered.
3. **Infrastructure visible, never noisy.** Output routing, driver status, and session state are always visible — a single glance confirms the system is live. They don't beg for attention.
4. **The humor is in the sounds.** The interface is serious. The personality comes from the content, not the chrome.
5. **Zero second-guessing.** Tile layout, key bindings, and category grouping are fixed and learnable. Nothing moves when you're mid-meeting.

## Accessibility & Inclusion

WCAG AA minimum. Full keyboard operability (already core to the product). High-contrast active states for tile feedback. Reduced motion: honor `prefers-reduced-motion` — keycap animation degrades to a simple border flash.
