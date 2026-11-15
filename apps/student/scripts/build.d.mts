export function bundleApp(entry?: string): string;
export function build(outDir?: string): { outDir: string; buildId: string; bytes: Record<string, number> };
