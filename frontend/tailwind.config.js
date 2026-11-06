/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0A0A0B",
        surface: "#111113",
        raised: "#18181B",
        border: "#27272A",
        bone: "#E9E6DF",
        muted: "#8A8A93",
        accent: "#7DD3FC",
        ok: "#22C55E",
        warn: "#F5B700",
        bad: "#EF4444",
      },
      fontFamily: {
        display: ["'Space Grotesk'", "system-ui", "sans-serif"],
        body: ["'Inter'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
        brand: ["'Syncopate'", "'Space Grotesk'", "sans-serif"],
      },
      borderRadius: {
        card: "12px",
        btn: "8px",
        input: "8px",
      },
      boxShadow: {
        subtle: "0 4px 20px rgba(0, 0, 0, 0.4)",
        drawer: "-4px 0 24px rgba(0, 0, 0, 0.6)",
      },
    },
  },
  plugins: [],
};
