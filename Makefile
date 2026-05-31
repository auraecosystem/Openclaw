SHELL := /bin/sh

PLUGIN_DIR ?= ../../plugins/caviclaw-plugin
PLUGIN_ID ?= caviclaw
PLUGIN_INSTALL_FLAGS ?= --force
PLUGIN_WATCH_PATHS ?= $(PLUGIN_DIR)/dist:$(PLUGIN_DIR)/openclaw.plugin.json:$(PLUGIN_DIR)/package.json
OPENCLAW ?= pnpm openclaw
PLUGIN_GATEWAY_WATCH ?= pnpm gateway:watch:raw

.PHONY: help plugin-install plugin-link plugin-dev plugin-inspect require-plugin-dir

help:
	@printf '%s\n' \
		'Targets:' \
		'  plugin-install  Pack PLUGIN_DIR and install with npm-pack:' \
		'  plugin-link     Link PLUGIN_DIR for local development' \
		'  plugin-dev      Link, watch plugin TypeScript, and run gateway watch' \
		'  plugin-inspect  Inspect PLUGIN_ID runtime registration'

require-plugin-dir:
	@test -n "$(PLUGIN_DIR)" || { \
		printf '%s\n' 'PLUGIN_DIR is required, for example:'; \
		printf '%s\n' '  make plugin-install PLUGIN_DIR=../../plugins/caviclaw-plugin PLUGIN_ID=caviclaw'; \
		exit 2; \
	}

plugin-install: require-plugin-dir
	@set -eu; \
	plugin_dir="$(PLUGIN_DIR)"; \
	echo "Packing plugin from $$plugin_dir"; \
	tarball=$$(cd "$$plugin_dir" && HUSKY=0 npm pack --silent .); \
	tarball_path="$$plugin_dir/$$tarball"; \
	echo "Installing npm-pack:$$tarball_path"; \
	$(OPENCLAW) plugins install "npm-pack:$$tarball_path" $(PLUGIN_INSTALL_FLAGS); \
	if [ -n "$(PLUGIN_ID)" ]; then \
		$(OPENCLAW) plugins inspect "$(PLUGIN_ID)" --runtime --json; \
	fi

plugin-link: require-plugin-dir
	$(OPENCLAW) plugins install --link "$(PLUGIN_DIR)"

plugin-dev: require-plugin-dir
	@set -eu; \
	plugin_dir="$(PLUGIN_DIR)"; \
	echo "Building plugin from $$plugin_dir"; \
	(cd "$$plugin_dir" && pnpm exec tsc -p tsconfig.json); \
	$(OPENCLAW) plugins install --link "$$plugin_dir"; \
	echo "Watching plugin TypeScript from $$plugin_dir"; \
	(cd "$$plugin_dir" && pnpm exec tsc -p tsconfig.json --watch --preserveWatchOutput) & \
	tsc_pid=$$!; \
	trap 'kill "$$tsc_pid" 2>/dev/null || true' EXIT INT TERM; \
	OPENCLAW_WATCH_EXTRA_PATHS="$(PLUGIN_WATCH_PATHS)" $(PLUGIN_GATEWAY_WATCH)

plugin-inspect:
	@test -n "$(PLUGIN_ID)" || { \
		printf '%s\n' 'PLUGIN_ID is required, for example:'; \
		printf '%s\n' '  make plugin-inspect PLUGIN_ID=caviclaw'; \
		exit 2; \
	}
	$(OPENCLAW) plugins inspect "$(PLUGIN_ID)" --runtime --json
