const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const STUDIO_JOB_STORAGE_KEY = "aas.studioJob.v1";
export const ANALYSIS_VIDEO_JOB_STORAGE_KEY = "aas.analysisVideoJob.v1";

export function parseStoredJobId(raw: string | null) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { jobId?: unknown };
    return typeof parsed.jobId === "string" && JOB_ID.test(parsed.jobId) ? parsed.jobId : "";
  } catch {
    return "";
  }
}

export function serializeStoredJobId(jobId: string) {
  return JOB_ID.test(jobId) ? JSON.stringify({ jobId }) : null;
}

export function rememberJob(storage: Pick<Storage, "setItem">, key: string, jobId: string) {
  const stored = serializeStoredJobId(jobId);
  if (stored) storage.setItem(key, stored);
}

export function forgetJob(storage: Pick<Storage, "removeItem">, key: string) {
  storage.removeItem(key);
}

export function userFacingClientError(error: unknown, fallback: string) {
  if (error instanceof TypeError) return "ネットワークに接続できませんでした。通信状況を確認して、もう一度お試しください。";
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
