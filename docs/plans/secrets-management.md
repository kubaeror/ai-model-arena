# Secrets Management Plan

## Problem
- API keys stored in k8s Secret → env vars → process.env
- No way to edit keys from dashboard without kubectl
- No environment detection (k8s vs bare-metal)
- Custom providers need API keys too, currently broken

## Architecture

```
Dashboard UI → API /api/secrets → SecretStore
    ↓ k8s mode                          ↓ non-k8s mode
patches provider-keys Secret      reads/writes .env file
    ↓ mounted as files                 ↓ process.env
/etc/arena/secrets/OPENAI_API_KEY   process.env.OPENAI_API_KEY
    ↓                                   ↓
adapter picks up via SecretStore.get(envVar)
```

## Phases

### 1. Platform Detection — `src/env/detect.ts`
- Check `/var/run/secrets/kubernetes.io/serviceaccount/token` → k8s
- OR `KUBERNETES_SERVICE_HOST` env → k8s
- Lazy singleton: `getPlatform()` returns `'kubernetes' | 'bare-metal'`

### 2. Secret Store — `src/secrets/store.ts`
```
class SecretStore {
  get(envVar: string): string | undefined
  set(envVar: string, value: string): Promise<void>
  delete(envVar: string): Promise<void>
  list(): Record<string, string>  // masked
}
```
- **K8s mode**: reads from `/etc/arena/secrets/{envVar}`, writes via k8s API patch
- **Non-k8s mode**: reads from `process.env`, writes to `.env` file

### 3. Dashboard Secrets API — `src/dashboard-server/routes/secrets.ts`
```
GET  /api/secrets          → list all known env vars with status (set/missing)
PUT  /api/secrets/:envVar  → set key value → patches k8s Secret or writes .env
DELETE /api/secrets/:envVar → remove key
```
- Admin-only, audit-logged

### 4. K8s Manifest Changes — Switch envFrom → volume mount
Replace in all 5 workloads (dashboard, 3 runners, scheduler):
```yaml
# Before:
envFrom:
  - secretRef:
      name: provider-keys

# After:
volumeMounts:
  - name: provider-keys
    mountPath: /etc/arena/secrets
    readOnly: true
volumes:
  - name: provider-keys
    secret:
      secretName: provider-keys
```
Filesystem-mounted Secrets auto-refresh via kubelet (no pod restart needed).

### 5. Wire SecretStore into runner/worker
```typescript
// runner.ts — replace process.env[descriptor.envVar] with:
import { secretStore } from '../secrets/store.js';
const apiKey = descriptor?.envVar ? secretStore.get(descriptor.envVar) : undefined;
```

### 6. Dashboard UI — `SecretsPanel.tsx`
- Table: Provider Icon | Name | Env Var | Status (✓ set / ✗ missing) | Actions (Edit, Delete)
- Edit modal: masked input, save → PUT /api/secrets/:envVar
- Add modal: provider dropdown + key input
- TanStack Query mutations with optimistic updates

### 7. Custom Providers on K8s
- `loadCustomFromDb()` is called in worker.ts but NOT in runner.ts startup
- Fix: add `registry.loadCustomFromDb(getDb())` after `loadBuiltins()` in runner.ts
- Custom provider API keys work because SecretStore resolves env vars dynamically
- Network policies are permissive for runner egress (0.0.0.0/0 except private ranges)

## Files: 4 create, 11 modify, 5 manifest changes
