import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Acquisition Search",
    short_name: "AI Acquisition",
    description: "写真と一文、または商品URLから短い広告動画を作る",
    start_url: "/",
    display: "standalone",
    background_color: "#050609",
    theme_color: "#050609",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
