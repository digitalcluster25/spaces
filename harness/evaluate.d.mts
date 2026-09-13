export type HarnessCheck = { id: string; passed: boolean; message: string };
export type HarnessReport = { passed: boolean; schema_version: number; evaluated_at: string; checks: HarnessCheck[] };
export function mergeHarnessConfig(defaults: Record<string, any>, current: Record<string, any> | null | undefined): Record<string, any>;
export function evaluateHarnessConfig(config: Record<string, any>): HarnessReport;
export const requiredTrue: string[];
