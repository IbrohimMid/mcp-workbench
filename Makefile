.PHONY: up server tunnel install-systemd smoke-test doctor lint-security

up:
	./scripts/up.sh

server:
	./scripts/start-server.sh

tunnel:
	./scripts/start-tunnel.sh

install-systemd:
	./scripts/install-systemd.sh

smoke-test:
	node ./scripts/smoke-test.mjs

doctor:
	node ./scripts/doctor.mjs

lint-security:
	node ./scripts/security-check.mjs
