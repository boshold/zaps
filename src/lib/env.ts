export function getEnv(key: string): string | undefined {
  // eslint-disable-next-line no-process-env -- Centralized env access
  return process.env[key];
}

export function getProcessEnv(): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- Centralized env access
  return process.env;
}
