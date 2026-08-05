package main

import rego.v1

container_has_resource_requests(container) if {
	container.resources.requests.cpu
	container.resources.requests.memory
}

container_has_resource_limits(container) if {
	container.resources.limits.cpu
	container.resources.limits.memory
}

deny contains msg if {
	some container in all_containers
	not container_has_resource_requests(container)
	msg := sprintf("%s/%s: container %q is missing resources.requests with cpu and memory", [input.kind, input.metadata.name, container.name])
}

deny contains msg if {
	some container in all_containers
	not container_has_resource_limits(container)
	msg := sprintf("%s/%s: container %q is missing resources.limits with cpu and memory", [input.kind, input.metadata.name, container.name])
}
