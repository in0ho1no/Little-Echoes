declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8'): string;
  export function writeFileSync(path: string, data: string, encoding: 'utf-8'): void;
  export function readdirSync(path: string): string[];
}

declare const process: { env: Record<string, string | undefined> };

declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
