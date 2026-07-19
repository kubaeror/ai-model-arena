// Ambient declaration for the `pm2` npm package.
// We declare a focused, typed surface of the programmatic API we use instead
// of depending on @types/pm2. Method names like `delete` are reserved words
// as standalone function names but are fine as method names on an interface.

declare module 'pm2' {
  export interface Pm2ProcessStatus {
    name?: string;
    pid?: number;
    pm_id?: number;
    pm2_env?: {
      status?: string;
      pm_uptime?: number;
      created_at?: number;
      cpu?: number;
      memory?: number;
      restart_time?: number;
      unstable_restarts?: number;
      exit_code?: number | null;
      [key: string]: unknown;
    };
    monit?: { cpu?: number; memory?: number };
  }

  export interface StartOptions {
    name?: string;
    script?: string;
    args?: string | string[];
    interpreter?: string | 'none';
    interpreter_args?: string;
    cwd?: string;
    exec_mode?: 'fork' | 'cluster';
    instances?: number;
    autorestart?: boolean;
    max_restarts?: number;
    restart_delay?: number;
    out_file?: string | boolean;
    error_file?: string | boolean;
    merge_logs?: boolean;
    time?: boolean;
    env?: Record<string, string | undefined>;
    [key: string]: unknown;
  }

  export interface Pm2Api {
    connect(cb: (err: Error | null) => void): void;
    disconnect(cb?: (err: Error | null) => void): void;
    start(
      options: StartOptions | string,
      cb: (err: Error | null, proc: Pm2ProcessStatus | Pm2ProcessStatus[]) => void,
    ): void;
    list(cb: (err: Error | null, list: Pm2ProcessStatus[]) => void): void;
    describe(
      process: string | number,
      cb: (err: Error | null, list: Pm2ProcessStatus[]) => void,
    ): void;
    // `delete` is a reserved word, but valid as a method name on an interface.
    delete(process: string | number | 'all', cb: (err: Error | null) => void): void;
    restart(process: string | number | 'all', cb: (err: Error | null) => void): void;
    stop(process: string | number | 'all', cb: (err: Error | null) => void): void;
    flush(process: string | number | 'all', cb: (err: Error | null) => void): void;
  }

  const pm2: Pm2Api;
  export default pm2;
}

