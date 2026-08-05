package main

import rego.v1

container_has_security_context(container) if {
	container.securityContext
}

container_run_as_non_root(container) if {
	container.securityContext.runAsNonRoot == true
}

pod_run_as_non_root if {
	some ps in pod_specs
	ps.securityContext.runAsNonRoot == true
}

all_capabilities_dropped(container) if {
	some drop in container.securityContext.capabilities.drop
	drop == "ALL"
}

deny contains msg if {
	some container in all_containers
	not container_has_security_context(container)
	msg := sprintf("%s/%s: container %q has no securityContext", [input.kind, input.metadata.name, container.name])
}

deny contains msg if {
	some container in all_containers
	not container_run_as_non_root(container)
	not pod_run_as_non_root
	msg := sprintf("%s/%s: container %q does not run as non-root (runAsNonRoot: true missing from container and pod securityContext)", [input.kind, input.metadata.name, container.name])
}

deny contains msg if {
	some container in all_containers
	container.securityContext.privileged == true
	msg := sprintf("%s/%s: container %q is privileged", [input.kind, input.metadata.name, container.name])
}

deny contains msg if {
	some container in all_containers
	container.securityContext.allowPrivilegeEscalation == true
	msg := sprintf("%s/%s: container %q allows privilege escalation", [input.kind, input.metadata.name, container.name])
}

deny contains msg if {
	some container in all_containers
	not all_capabilities_dropped(container)
	msg := sprintf("%s/%s: container %q must drop ALL capabilities", [input.kind, input.metadata.name, container.name])
}
