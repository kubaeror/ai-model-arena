package main

import rego.v1

# Established pattern in k8s/base: every long-running container in a
# Deployment/StatefulSet has a livenessProbe (runners and dashboard also
# define a startupProbe). One-shot init containers (db-migrate) are
# restarted by Kubernetes on failure and carry no probes.
container_has_probe(container) if {
	container.livenessProbe
}

container_has_probe(container) if {
	container.startupProbe
}

deny contains msg if {
	input.kind in {"Deployment", "StatefulSet"}
	some container in input.spec.template.spec.containers
	not container_has_probe(container)
	msg := sprintf("%s/%s: container %q has no livenessProbe or startupProbe", [input.kind, input.metadata.name, container.name])
}
