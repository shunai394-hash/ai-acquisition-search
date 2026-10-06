export default function Loading() {
  return (
    <main className="route-loading" aria-busy="true" aria-live="polite">
      <span className="route-loading-mark" aria-hidden="true" />
      <span className="route-loading-label">市場シグナルを準備しています…</span>
    </main>
  );
}
