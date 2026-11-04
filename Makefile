# Tandem — find people to build with.
#
#   make dev     bring the stack up locally
#   make demo    prove it works end to end, on throwaway ports
#   make test    run every suite
#
# Nothing here needs `npm install` or `pip install`. That is a feature.

SHELL := /bin/bash
PY := python3
NODE := node

API_DIR := services/api
MATCHER_DIR := services/matcher
SCOUT_DIR := services/scout

.PHONY: help
help:
	@echo "tandem"
	@echo
	@echo "  make dev          run api + matcher + web on localhost"
	@echo "  make demo         end-to-end demo on throwaway ports (safe to re-run)"
	@echo "  make typecheck    type check the api (needs npm install)"
	@echo "  make experiments-test  the two oracles and the harness"
	@echo "  make experiment   one run; READER=cmd:'...' plugs in a real reader"
	@echo "  make metrics      the three process numbers, from evidence
	@echo "  make injections   attempts to instruct whoever reads the digest"
	@echo "  make test         all suites (matcher, api, scout)"
	@echo "  make test-fast    api + matcher only"
	@echo "  make seed         load the demo cohort into a running api"
	@echo "  make match        show Ada's matches from a running api"
	@echo "  make doctor       check that a running deployment is healthy"
	@echo "  make scout        discovery run against recorded data (no network)"
	@echo "  make scout-live   discovery run against public endpoints"
	@echo "  make handles      list the accounts you declared"
	@echo "  make handle-add   NETWORK=github HANDLE=you  add one (the consent step)"
	@echo "  make members      read every consenting member's declared handles"
	@echo "  make web          serve the intake page on :5173"
	@echo "  make clean        remove local runtime data"
	@echo

.PHONY: metrics
metrics:
	@$(PY) scripts/metrics.py

.PHONY: injections
injections:
	@if [ -s data/scout/injection-log.jsonl ]; then \
	  echo "attempts to instruct the reader (each one also closed a connection):"; \
	  $(PY) -c 'import json,sys; [print("  " + (lambda e: f"{e[\"at\"][:19]}  {e[\"source\"]:<14} {e[\"rule\"]:<22} {e[\"action\"]}")(json.loads(l))) for l in open("data/scout/injection-log.jsonl") if l.strip()]'; \
	else echo "no attempts logged"; fi

.PHONY: plans
plans:
	@node experiments/harness/run.ts --experiment behavior --variant clean \
	  --reader plan:experiments/plans/clean.json --n 1 --out experiments/results/plan-clean.json
	@node experiments/harness/run.ts --experiment behavior --variant poisoned \
	  --reader plan:experiments/plans/poisoned.json --n 1 --out experiments/results/plan-poisoned.json
	@node experiments/harness/run.ts --experiment behavior --variant poisoned \
	  --reader plan:experiments/plans/adopting.json --n 1 --out experiments/results/plan-adopting.json

.PHONY: experiments-test
experiments-test:
	@echo "── experiments ──"
	@node --test experiments/harness/*.test.ts
	@$(PY) -m unittest discover -s experiments/harness -p "test_*.py" -q

.PHONY: plans
plans:
	@node experiments/harness/run.ts --experiment behavior --variant clean \
	  --reader plan:experiments/plans/clean.json --n 1 --out experiments/results/plan-clean.json
	@node experiments/harness/run.ts --experiment behavior --variant poisoned \
	  --reader plan:experiments/plans/poisoned.json --n 1 --out experiments/results/plan-poisoned.json
	@node experiments/harness/run.ts --experiment behavior --variant poisoned \
	  --reader plan:experiments/plans/adopting.json --n 1 --out experiments/results/plan-adopting.json

.PHONY: experiment
experiment:
	@node experiments/harness/run.ts --experiment $${EXPERIMENT:-behavior} \
	  --variant $${VARIANT:-clean} --reader $${READER:-null} --n $${N:-1} \
	  --out experiments/results/$${EXPERIMENT:-behavior}-$${VARIANT:-clean}.json

.PHONY: typecheck
typecheck:
	@cd $(API_DIR) && npm install --no-audit --no-fund --silent && npx tsc --noEmit && echo "api types: clean"

.PHONY: dev
dev:
	@./scripts/dev.sh

.PHONY: demo
demo:
	@./scripts/demo.sh

.PHONY: test
test: test-matcher test-api test-scout test-tools
	@echo
	@echo "all suites passed"

.PHONY: test-tools
test-tools:
	@echo "── tools ──"
	@$(PY) -m unittest discover -s scripts/test -q

.PHONY: test-fast
test-fast: test-matcher test-api

.PHONY: test-matcher
test-matcher:
	@echo "── matcher ──"
	@cd $(MATCHER_DIR) && $(PY) -m unittest discover -s test

.PHONY: test-api
test-api:
	@echo "── api ──"
	@cd $(API_DIR) && $(NODE) --test test/*.test.ts

.PHONY: test-scout
test-scout:
	@echo "── scout ──"
	@cd $(SCOUT_DIR) && $(PY) -m unittest discover -s test

.PHONY: seed
seed:
	@./cli/tandemctl seed

.PHONY: match
match:
	@./cli/tandemctl match Ada

.PHONY: doctor
doctor:
	@./cli/tandemctl doctor

.PHONY: scout
scout:
	@cd $(SCOUT_DIR) && $(PY) -m tandem_scout --replay test/fixtures --topics ai,security

.PHONY: scout-live
scout-live:
	@cd $(SCOUT_DIR) && $(PY) -m tandem_scout --live --topics ai,security

.PHONY: handles
handles:
	@./scripts/add-handle.sh list

.PHONY: handle-add
handle-add:
	@./scripts/add-handle.sh add $(NETWORK) $(HANDLE)

.PHONY: members
members:
	@cd $(SCOUT_DIR) && $(PY) -m tandem_scout --members --api $${TANDEM_API:-http://127.0.0.1:8080}

.PHONY: web
web:
	@cd web && $(PY) -m http.server 5173 --bind 127.0.0.1

.PHONY: clean
clean:
	@rm -f data/tandem.db data/tandem.db-shm data/tandem.db-wal data/demo-tokens.json
	@rm -rf data/scout
	@find . -name __pycache__ -type d -prune -exec rm -rf {} +
	@echo "cleaned local runtime data"
