"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("AI Acquisition Search page error", error);
  }, [error]);

  return (
    <main className="error-screen">
      <p className="eyebrow">SYSTEM PAUSED</p>
      <h1>一度だけ、立て直します。</h1>
      <p>ページの処理中に予期しないエラーが発生しました。保存済みのデータはそのままです。</p>
      <button type="button" onClick={() => reset()}>もう一度読み込む</button>
    </main>
  );
}
