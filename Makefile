.DEFAULT_GOAL := help

NODE_BIN        := ./node_modules/.bin
TSC             := $(NODE_BIN)/tsc
ELECTRON        := $(NODE_BIN)/electron
ELECTRON_BUILDER:= $(NODE_BIN)/electron-builder

# ── Colours ────────────────────────────────────────────────────────────
RESET  := \033[0m
BOLD   := \033[1m
AMBER  := \033[33m
GREEN  := \033[32m
DIM    := \033[2m

.PHONY: help install build dev app dmg dmg-universal dist icon icon-from-svg clean test sounds example-pack

# ── Help ────────────────────────────────────────────────────────────────
help:
	@printf "\n$(BOLD)MeetingBoost$(RESET) — build targets\n\n"
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS=":.*## "}; {printf "  $(AMBER)%-12s$(RESET) %s\n", $$1, $$2}'
	@printf "\n$(DIM)Tip: place a 1024×1024 PNG at assets/icon.png, then run$(RESET) make icon\n\n"

# ── Dev ─────────────────────────────────────────────────────────────────
install: ## Install all npm dependencies
	npm install

build: ## Compile TypeScript → JavaScript
	$(TSC)

dev: build ## Launch in dev mode with DevTools open
	ELECTRON_IS_DEV=1 $(ELECTRON) .

# ── Test & Sounds ───────────────────────────────────────────────────────
test: ## Run unit test suite (sounds integrity + TypeScript)
	python3 -m pytest tests/test_sounds.py -v

test-e2e: build ## Run Playwright E2E tests against the Electron app
	npx playwright test

sounds: ## Download all sound packs (Pixabay + YouTube)
	python3 scripts/download_sounds.py

example-pack: ## Rebuild assets/classics.mbpack — a real importable example
	python3 scripts/build_example_mbpack.py

# ── Distribution ────────────────────────────────────────────────────────
app: build ## Build unpacked .app bundle (fast, host arch — for local smoke testing)
	$(ELECTRON_BUILDER) --mac dir
	@printf "\n$(GREEN)App:$(RESET) release/mac*/MeetingBoost.app\n"

dmg: build ## Build .dmg installer (host arch — fast)
	$(ELECTRON_BUILDER) --mac dmg
	@printf "\n$(GREEN)DMG:$(RESET) release/MeetingBoost-*.dmg\n"

dmg-universal: build ## Build .dmg for both arm64 and x64 — slower, downloads x64 Electron
	$(ELECTRON_BUILDER) --mac dmg --arm64 --x64
	@printf "\n$(GREEN)DMGs:$(RESET) release/MeetingBoost-*.dmg\n"

dist: build ## Full release — .dmg + .zip, both arches (CI uses this on tags)
	$(ELECTRON_BUILDER) --mac
	@printf "\n$(GREEN)Release artefacts:$(RESET) release/\n"

# ── Icon ────────────────────────────────────────────────────────────────
# Requires: assets/icon.png (1024×1024 px, square)
# Produces: assets/icon.icns  (referenced by electron-builder)
icon: ## Generate assets/icon.icns from assets/icon.png
	@test -f assets/icon.png || (printf "$(AMBER)Error:$(RESET) assets/icon.png not found\n" && exit 1)
	@mkdir -p assets/icon.iconset
	sips -z 16   16   assets/icon.png --out assets/icon.iconset/icon_16x16.png
	sips -z 32   32   assets/icon.png --out assets/icon.iconset/icon_16x16@2x.png
	sips -z 32   32   assets/icon.png --out assets/icon.iconset/icon_32x32.png
	sips -z 64   64   assets/icon.png --out assets/icon.iconset/icon_32x32@2x.png
	sips -z 128  128  assets/icon.png --out assets/icon.iconset/icon_128x128.png
	sips -z 256  256  assets/icon.png --out assets/icon.iconset/icon_128x128@2x.png
	sips -z 256  256  assets/icon.png --out assets/icon.iconset/icon_256x256.png
	sips -z 512  512  assets/icon.png --out assets/icon.iconset/icon_256x256@2x.png
	sips -z 512  512  assets/icon.png --out assets/icon.iconset/icon_512x512.png
	cp assets/icon.png assets/icon.iconset/icon_512x512@2x.png
	iconutil -c icns assets/icon.iconset -o assets/icon.icns
	@rm -rf assets/icon.iconset
	@printf "$(GREEN)Generated:$(RESET) assets/icon.icns\n"

icon-from-svg: ## Rasterise assets/logo.svg → 1024px PNG, then build .icns
	@test -f assets/logo.svg || (printf "$(AMBER)Error:$(RESET) assets/logo.svg not found\n" && exit 1)
	@if command -v rsvg-convert >/dev/null 2>&1; then \
	   rsvg-convert -w 1024 -h 1024 assets/logo.svg > assets/icon.png; \
	 elif command -v qlmanage >/dev/null 2>&1; then \
	   qlmanage -t -s 1024 -o /tmp assets/logo.svg >/dev/null 2>&1 && \
	   mv /tmp/logo.svg.png assets/icon.png; \
	 else \
	   printf "$(AMBER)Error:$(RESET) install rsvg-convert (brew install librsvg) or use qlmanage\n"; exit 1; \
	 fi
	@$(MAKE) -s icon

# ── Clean ────────────────────────────────────────────────────────────────
clean: ## Remove compiled JS and release artefacts (keeps node_modules)
	rm -f main.js preload.js
	rm -rf release/
	@printf "$(GREEN)Cleaned$(RESET)\n"
