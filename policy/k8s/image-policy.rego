package main

import rego.v1

# Dev/e2e overlays are exempt by declaring the label
# policy/image-policy: exempt in their kustomization (see k8s/overlays/dev).
image_policy_exempt if {
	input.metadata.labels["policy/image-policy"] == "exempt"
}

# A tag-less image resolves to :latest implicitly.
image_uses_latest(image) if {
	endswith(image, ":latest")
}

image_uses_latest(image) if {
	not contains(image, ":")
}

deny contains msg if {
	not image_policy_exempt
	some container in all_containers
	image_uses_latest(container.image)
	msg := sprintf("%s/%s: container %q uses image %q tagged :latest (pin an immutable digest; dev/e2e overlays must set label policy/image-policy: exempt)", [input.kind, input.metadata.name, container.name, container.image])
}

deny contains msg if {
	not image_policy_exempt
	some container in all_containers
	container.imagePullPolicy == "Never"
	msg := sprintf("%s/%s: container %q sets imagePullPolicy: Never", [input.kind, input.metadata.name, container.name])
}
