package main

import rego.v1

# Pod specs differ per kind: Deployment/StatefulSet/DaemonSet put them under
# spec.template.spec, CronJob/Job under spec.jobTemplate.spec.template.spec.
pod_specs contains spec if {
	input.kind != "CronJob"
	spec := input.spec.template.spec
}

pod_specs contains spec if {
	input.kind == "CronJob"
	spec := input.spec.jobTemplate.spec.template.spec
}

# Every container, regular and init, across all workload kinds.
all_containers contains container if {
	some ps in pod_specs
	some container in ps.containers
}

all_containers contains container if {
	some ps in pod_specs
	some container in ps.initContainers
}
