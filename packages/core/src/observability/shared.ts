export const INSTANCE_ID_ENV = "OPENCODE_INTERNAL_INSTANCE_ID"
export const COMPONENT_ENV = "OPENCODE_INTERNAL_COMPONENT"

const safeInstanceID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function resolveInstanceID(value: string | undefined, generate: () => string = () => crypto.randomUUID()) {
  return value && safeInstanceID.test(value) ? value : generate()
}

export const instanceID = resolveInstanceID(process.env[INSTANCE_ID_ENV])
export const runID = instanceID.slice(0, 8)
