.PHONY: up server tunnel install-systemd smoke-test doctor lint-security validate-config dashboard verify worker-generate worker-up worker-doctor worker-install-systemd worker-list

up:
	./scripts/up.sh

server:
	./scripts/start-server.sh

tunnel:
	./scripts/start-tunnel.sh

install-systemd:
	./scripts/install-systemd.sh

worker-generate:
	node ./scripts/generate-worker.mjs $(ARGS)

worker-up:
	./scripts/worker-up.sh "$(WORKER)"

worker-doctor:
	./scripts/worker-doctor.sh "$(WORKER)"

worker-install-systemd:
	./scripts/worker-install-systemd.sh "$(WORKER)"

worker-list:
	./scripts/worker-list.sh

smoke-test:
	node ./scripts/smoke-test.mjs

doctor:
	node ./scripts/doctor.mjs

lint-security:
	node ./scripts/security-check.mjs

validate-config:
	node ./scripts/validate-config.mjs

dashboard:
	@printf 'Open http://127.0.0.1:%s/dashboard\n' "$${MCP_PORT:-3333}"

verify:
	node --check server/workbench-server.mjs
	node --check server/workbench-dashboard.mjs
	node --check scripts/smoke-test.mjs
	node --check scripts/doctor.mjs
	node --check scripts/security-check.mjs
	node --check scripts/generate-worker.mjs
	node --check scripts/validate-config.mjs
	bash -n scripts/*.sh
	node ./scripts/security-check.mjs
	node ./scripts/validate-config.mjs
	node ./scripts/smoke-test.mjs
