/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aventas: {
          ink: "#0b1220",
          panel: "#111a2e",
          edge: "#1e2b47",
          accent: "#2dd4a7",
          accentDim: "#1a8f74",
          warn: "#f5b544",
          danger: "#ef6a6a",
          muted: "#8b9bb8",
        },
      },
      fontFamily: {
        display: ["'Space Grotesk'", "system-ui", "sans-serif"],
        body: ["'Inter'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
