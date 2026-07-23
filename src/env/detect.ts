import fs from 'node:fs';

let _platform: 'kubernetes' | 'bare-metal' | null = null;

export function detectPlatform(): 'kubernetes' | 'bare-metal' {
  if (_platform) return _platform;

  // Check for k8s service account token mount — definitive sign of in-cluster
  if (fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    _platform = 'kubernetes';
  } else if (process.env.KUBERNETES_SERVICE_HOST) {
    _platform = 'kubernetes';
  } else {
    _platform = 'bare-metal';
  }

  return _platform;
}

export function isKubernetes(): boolean {
  return detectPlatform() === 'kubernetes';
}

export function getKubeNamespace(): string {
  if (!isKubernetes()) return '';
  return process.env.KUBE_NAMESPACE ?? 'ai-arena';
}

export function getKubeSecretName(): string {
  return process.env.KUBE_SECRET_NAME ?? 'provider-keys';
}
