export function getEnv(key: string): string | undefined {
  return process.env[key];
}

export function getProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}
