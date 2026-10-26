const SUPERVISOR_CONTROL_ENV_PREFIX = "PAPERCLIP_SUPERVISOR_";

export function sanitizeSupervisorControlEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith(SUPERVISOR_CONTROL_ENV_PREFIX)) {
      delete env[key];
    }
  }
  return env;
}
