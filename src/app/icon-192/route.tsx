export const runtime = "nodejs";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071d63"/><stop offset=".52" stop-color="#0042c8"/><stop offset="1" stop-color="#10d8c0"/></linearGradient></defs>
<rect width="192" height="192" rx="42" fill="url(#g)"/>
<text x="30" y="116" fill="#fff" font-family="Arial,sans-serif" font-size="42" font-weight="800">EC</text>
<path d="M110 105 C120 108 126 110 133 109 L144 82 L153 118 L161 100 L173 100" fill="none" stroke="#11e5dc" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function GET() {
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
}
