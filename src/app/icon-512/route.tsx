export const runtime = "nodejs";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071d63"/><stop offset=".52" stop-color="#0042c8"/><stop offset="1" stop-color="#10d8c0"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<text x="78" y="306" fill="#fff" font-family="Arial,sans-serif" font-size="112" font-weight="800">EC</text>
<path d="M302 278 C330 286 346 292 366 290 L398 214 L424 314 L450 262 L478 262" fill="none" stroke="#11e5dc" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function GET() {
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
}
